import type { ContractType, NormalisedJob } from '../lib/types';

/** Recruiter noise that shows up appended to otherwise identical job titles. */
const RECRUITER_SUFFIXES = [
  /\b(?:fully\s+)?remote\b/gi,
  /\b(?:outside|inside)\s*ir\s*-?\s*35\b/gi,
  /\bhybrid\b/gi,
  /\bcontract\b/gi,
  /\bpermanent\b/gi,
  /\bperm\b/gi,
  /\buk\b/gi,
  /\bftc\b/gi,
  /\b\d+\s*(?:month|week|year)s?\b/gi,
  /\bup to\s*£[\d,.kK]+/gi,
  /£[\d,.kK]+\s*(?:-|to)\s*£?[\d,.kK]+/gi,
  /\bper\s+(?:annum|day|hour)\b/gi,
];

/** Turn source HTML into something a model can read and a human can quote. */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x20;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The cross-source dedupe key. Two boards list the same role with different IDs
 * and slightly different titles; this collapses them onto one string.
 */
export function normaliseForHash(
  title: string,
  employer: string | null,
  salaryMin: number | null,
  salaryMax: number | null,
): string {
  let t = title.toLowerCase();
  for (const pattern of RECRUITER_SUFFIXES) t = t.replace(pattern, ' ');
  t = t
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const e = (employer ?? '')
    .toLowerCase()
    .replace(/\b(?:ltd|limited|plc|llp|inc|group|recruitment|resourcing|solutions)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Salary buckets to the nearest £5k so a £95,000 vs £95,500 listing still matches.
  const bucket = (n: number | null) => (n ? Math.round(n / 5000) : 0);

  return `${t}|${e}|${bucket(salaryMin)}|${bucket(salaryMax)}`;
}

export async function contentHash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The agency-duplicate key: the same role, advertised by three different
 * recruiters, is three different employers and so three different content
 * hashes. Dropping the employer collapses them.
 *
 * Returns null when no salary is stated, because title alone is too weak — two
 * genuinely separate "Network Architect" posts would collapse into one.
 */
export function normaliseForRoleHash(
  title: string,
  salaryMin: number | null,
  salaryMax: number | null,
  period: 'annual' | 'daily' | 'unknown',
): string | null {
  if (!salaryMin && !salaryMax) return null;

  let t = title.toLowerCase();
  for (const pattern of RECRUITER_SUFFIXES) t = t.replace(pattern, ' ');
  t = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Annualise first so a £600/day listing and a £156k listing of the same role
  // land in the same bucket, then bucket coarsely — agencies round differently.
  const annual = annualise(salaryMin ?? salaryMax, period);
  const bucket = annual ? Math.round(annual / 20000) : 0;
  return `${t}|${bucket}`;
}

/** Attach both dedupe hashes to a job that has everything else filled in. */
export async function withHash(
  job: Omit<NormalisedJob, 'content_hash' | 'role_hash'>,
): Promise<NormalisedJob> {
  const contentKey = normaliseForHash(job.title, job.employer, job.salary_min, job.salary_max);
  // A predicted salary is a machine's guess — Indeed and Adzuna both estimate
  // one when the employer states none, and neither says which figures are
  // theirs. role_hash buckets salary 20k wide, so an estimate of £72k and a
  // real £78k for the same title collapse and the real posting is dropped as a
  // duplicate of the guess. A guessed number is not a dedupe key.
  const roleKey = job.salary_predicted
    ? null
    : normaliseForRoleHash(job.title, job.salary_min, job.salary_max, job.salary_period);
  return {
    ...job,
    content_hash: await contentHash(contentKey),
    role_hash: roleKey ? await contentHash(roleKey) : null,
  };
}

/**
 * Boards publish contract pay as a day rate and permanent pay as an annual
 * salary in the same two fields. Left alone, a £600/day contract renders as
 * "£600" and reads as an insultingly low salary.
 *
 * Nothing in this niche pays under £2,000 a year, so a figure below that is a
 * day rate. 260 working days is the conventional annualisation.
 */
export const WORKING_DAYS_PER_YEAR = 260;

export function inferSalaryPeriod(
  salaryMin: number | null,
  salaryMax: number | null,
): 'annual' | 'daily' | 'unknown' {
  const value = salaryMin ?? salaryMax;
  if (!value) return 'unknown';
  return value < 2000 ? 'daily' : 'annual';
}

/** Everything on one scale, so a day rate and its annual equivalent compare. */
export function annualise(value: number | null, period: 'annual' | 'daily' | 'unknown'): number | null {
  if (!value) return null;
  return period === 'daily' ? value * WORKING_DAYS_PER_YEAR : value;
}

export function inferContractType(text: string, hint?: string | null): ContractType {
  if (hint === 'permanent' || hint === 'contract') return hint;
  const t = text.toLowerCase();
  if (/\b(?:day rate|per day|£\d+\s*(?:-|to)?\s*p\/?d|outside ir35|inside ir35|contract role|\d+\s*month contract)\b/.test(t)) {
    return 'contract';
  }
  if (/\bpermanent\b/.test(t)) return 'permanent';
  return 'unknown';
}

/** Does the source itself claim this is remote? Recorded, never trusted. */
export function looksRemote(title: string, description: string): number {
  const t = `${title} ${description}`.toLowerCase();
  return /\b(?:fully remote|100% remote|remote first|remote-first|work from home|home based|home-based|homeworking|remote)\b/.test(t)
    ? 1
    : 0;
}
