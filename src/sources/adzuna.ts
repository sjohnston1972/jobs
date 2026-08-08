import type { NormalisedJob } from '../lib/types';
import {
  inferContractType,
  inferSalaryPeriod,
  looksRemote,
  stripHtml,
  withHash,
} from '../pipeline/normalise';

const BASE = 'https://api.adzuna.com/v1/api/jobs/gb/search';

interface AdzunaResult {
  id: string;
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  contract_type?: string;
}

export async function fetchAdzuna(
  appId: string,
  appKey: string,
  query: string,
  lookbackDays: number,
  resultsPerPage = 50,
): Promise<NormalisedJob[]> {
  const url = new URL(`${BASE}/1`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('what', query);
  url.searchParams.set('max_days_old', String(lookbackDays));
  url.searchParams.set('results_per_page', String(resultsPerPage));
  url.searchParams.set('content-type', 'application/json');

  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Adzuna "${query}" — HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as { results?: AdzunaResult[] };

  const jobs: NormalisedJob[] = [];
  for (const r of data.results ?? []) {
    const title = (r.title ?? '').trim();
    if (!title || !r.id || !r.redirect_url) continue;

    const description = stripHtml(r.description);
    // Adzuna's predicted salary is a model output, not the employer's number.
    const predicted = String(r.salary_is_predicted ?? '0') === '1' ? 1 : 0;

    jobs.push(
      await withHash({
        id: `adzuna:${r.id}`,
        source: 'adzuna',
        source_id: String(r.id),
        title,
        employer: r.company?.display_name?.trim() || null,
        location_raw: r.location?.display_name?.trim() || null,
        remote_flag: looksRemote(title, description),
        contract_type: inferContractType(`${title} ${description}`, r.contract_type ?? null),
        salary_min: r.salary_min ?? null,
        salary_max: r.salary_max ?? null,
        salary_period: inferSalaryPeriod(r.salary_min ?? null, r.salary_max ?? null),
        salary_predicted: predicted,
        currency: 'GBP',
        url: r.redirect_url,
        description,
        // Adzuna descriptions are always an excerpt, and there is no detail endpoint.
        description_truncated: 1,
        posted_at: r.created ? new Date(r.created).toISOString() : null,
      }),
    );
  }
  return jobs;
}
