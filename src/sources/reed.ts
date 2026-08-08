import type { NormalisedJob } from '../lib/types';
import {
  inferContractType,
  inferSalaryPeriod,
  looksRemote,
  stripHtml,
  withHash,
} from '../pipeline/normalise';

const SEARCH_URL = 'https://www.reed.co.uk/api/1.0/search';
const DETAIL_URL = 'https://www.reed.co.uk/api/1.0/jobs';

interface ReedResult {
  jobId: number;
  employerName?: string | null;
  jobTitle: string;
  locationName?: string | null;
  minimumSalary?: number | null;
  maximumSalary?: number | null;
  currency?: string | null;
  date?: string | null; // dd/MM/yyyy
  jobDescription?: string | null;
  jobUrl: string;
}

/** Reed auth is HTTP Basic with the API key as username and no password. */
function authHeader(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

/** Reed dates are dd/MM/yyyy. Anything else comes back null rather than Invalid Date. */
export function parseReedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const [, dd, mm, yyyy] = match;
  return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`).toISOString();
}

export async function fetchReed(
  apiKey: string,
  query: string,
  lookbackDays: number,
  resultsToTake = 50,
): Promise<NormalisedJob[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('keywords', query);
  url.searchParams.set('resultsToTake', String(resultsToTake));
  url.searchParams.set('resultsToSkip', '0');

  const response = await fetch(url.toString(), {
    headers: { authorization: authHeader(apiKey), accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Reed "${query}" — HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as { results?: ReedResult[] };
  const cutoff = Date.now() - lookbackDays * 86_400_000;

  const jobs: NormalisedJob[] = [];
  for (const r of data.results ?? []) {
    const postedAt = parseReedDate(r.date);
    // Reed search has no date filter, so the lookback window is applied here.
    if (postedAt && Date.parse(postedAt) < cutoff) continue;

    const description = stripHtml(r.jobDescription);
    const title = (r.jobTitle ?? '').trim();
    if (!title) continue;

    jobs.push(
      await withHash({
        id: `reed:${r.jobId}`,
        source: 'reed',
        source_id: String(r.jobId),
        title,
        employer: r.employerName?.trim() || null,
        location_raw: r.locationName?.trim() || null,
        remote_flag: looksRemote(title, description),
        contract_type: inferContractType(`${title} ${description}`),
        salary_min: r.minimumSalary ?? null,
        salary_max: r.maximumSalary ?? null,
        salary_period: inferSalaryPeriod(r.minimumSalary ?? null, r.maximumSalary ?? null),
        salary_predicted: 0, // Reed publishes the employer's figure
        currency: r.currency ?? 'GBP',
        url: r.jobUrl,
        description,
        // Search results carry a shortened description; the detail call fills it in.
        description_truncated: 1,
        posted_at: postedAt,
      }),
    );
  }
  return jobs;
}

/**
 * Reed's search endpoint returns a shortened description. The scorer needs the
 * whole thing to judge whether "remote" is genuine, so the full record is
 * pulled — but only for jobs that already survived the prefilter, which keeps
 * the subrequest count down.
 */
export async function fetchReedDescription(
  apiKey: string,
  sourceId: string,
): Promise<string | null> {
  const response = await fetch(`${DETAIL_URL}/${sourceId}`, {
    headers: { authorization: authHeader(apiKey), accept: 'application/json' },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { jobDescription?: string | null };
  const text = stripHtml(data.jobDescription);
  return text || null;
}
