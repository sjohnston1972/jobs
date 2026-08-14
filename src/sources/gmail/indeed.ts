import type { IndeedParseResult, RawPosting } from './types';

/** Everything after this line is legal boilerplate, not postings. */
const FOOTER = /^Do not share this email$/m;

/** A posting block is identified by its click-through link. */
const CLICK_URL = /https:\/\/uk\.indeed\.com\/(?:rc|pagead)\/clk[^\s]*/;

/** Organic results carry a 16-character hex job key; sponsored slots do not. */
const JOB_KEY = /[?&]jk=([0-9a-f]{6,})/;

/** e.g. "£63,000 - £67,000 a year", "£88,000 a year", "£600 - £650 a day" */
const SALARY =
  /£\s*([\d,]+(?:\.\d+)?)(?:\s*-\s*£\s*([\d,]+(?:\.\d+)?))?\s+(?:a|an|per)\s+(year|month|week|day|hour)/i;

/**
 * Badges Indeed sprinkles between the salary and the snippet. They appear
 * inconsistently, which is why lines are classified by pattern rather than
 * counted. An unrecognised badge falls through into the snippet, which is
 * harmless — the scorer reads prose.
 */
const BADGES = new Set([
  'easily apply',
  'responsive employer',
  'urgently hiring',
  'hiring multiple candidates',
  'new',
]);

const DAY_MS = 86_400_000;
/** The conventional annualisation used elsewhere in this codebase. */
const HOURS_PER_DAY = 7.5;

function parseSalary(line: string): Pick<RawPosting, 'salaryMin' | 'salaryMax' | 'salaryPeriod'> | null {
  const match = line.match(SALARY);
  if (!match) return null;

  const num = (raw: string | undefined) => (raw ? Number(raw.replace(/,/g, '')) : null);
  let min = num(match[1]);
  let max = num(match[2]);
  const unit = match[3].toLowerCase();

  // Everything collapses onto annual or daily so salary_period stays a
  // two-value question and no migration is needed.
  let period: 'annual' | 'daily' = 'annual';
  let factor = 1;
  if (unit === 'year') period = 'annual';
  else if (unit === 'month') factor = 12;
  else if (unit === 'week') factor = 52;
  else if (unit === 'day') period = 'daily';
  else if (unit === 'hour') {
    period = 'daily';
    factor = HOURS_PER_DAY;
  }

  if (min !== null) min = Math.round(min * factor);
  if (max !== null) max = Math.round(max * factor);
  return { salaryMin: min, salaryMax: max, salaryPeriod: period };
}

/**
 * "Just posted" and "Today" mean the email's own date; "N days ago" counts
 * back from it. Only called on lines isAgeLine has already accepted, so a
 * line with no digits is deliberately read as zero days.
 */
function parseAge(line: string, receivedAt: Date): string {
  const days = Number(line.match(/(\d+)\+?\s+days?\s+ago/i)?.[1] ?? 0);
  return new Date(receivedAt.getTime() - days * DAY_MS).toISOString();
}

function isAgeLine(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (!t) return false;
  return (
    t === 'just posted' ||
    t === 'today' ||
    t === 'posted today' ||
    /^\d+\+?\s+days?\s+ago$/.test(t) ||
    /^(?:employer\s+)?active\s+\d+\+?\s+days?\s+ago$/.test(t)
  );
}

export function parseIndeedAlert(body: string, receivedAt: Date): IndeedParseResult {
  const cut = body.search(FOOTER);
  const region = cut >= 0 ? body.slice(0, cut) : body;

  const postings: RawPosting[] = [];
  let skippedSponsored = 0;

  for (const block of region.split(/\n\s*\n/)) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const urlIndex = lines.findIndex((l) => CLICK_URL.test(l));
    // Header and footer blocks have no click-through and are not postings.
    if (urlIndex < 2) continue;

    const url = lines[urlIndex].match(CLICK_URL)![0];
    const key = url.match(JOB_KEY);
    if (!key) {
      skippedSponsored++;
      continue;
    }

    const title = lines[0];
    const [employer, location] = splitEmployerLocation(lines[1]);

    let salary: ReturnType<typeof parseSalary> = null;
    let postedAt: string | null = null;
    const snippetLines: string[] = [];

    for (const line of lines.slice(2, urlIndex)) {
      if (!salary) {
        const parsed = parseSalary(line);
        if (parsed) {
          salary = parsed;
          continue;
        }
      }
      if (isAgeLine(line)) {
        postedAt = parseAge(line, receivedAt);
        continue;
      }
      if (BADGES.has(line.toLowerCase())) continue;
      snippetLines.push(line);
    }

    postings.push({
      source: 'indeed',
      sourceId: key[1],
      title,
      employer,
      location,
      salaryMin: salary?.salaryMin ?? null,
      salaryMax: salary?.salaryMax ?? null,
      salaryPeriod: salary?.salaryPeriod ?? 'unknown',
      snippet: snippetLines.join(' '),
      // The tracking link is personalised and the email asks that it not be
      // shared; the canonical form is stable and safe to store.
      url: `https://uk.indeed.com/viewjob?jk=${key[1]}`,
      postedAt: postedAt ?? receivedAt.toISOString(),
    });
  }

  return { postings, skippedSponsored };
}

/** "KBR - Leatherhead". Employer names contain hyphens, so split on the last one. */
function splitEmployerLocation(line: string): [string | null, string | null] {
  const at = line.lastIndexOf(' - ');
  if (at < 0) return [line.trim() || null, null];
  return [line.slice(0, at).trim() || null, line.slice(at + 3).trim() || null];
}
