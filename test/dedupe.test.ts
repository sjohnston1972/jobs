import { describe, expect, it } from 'vitest';
import { dedupe } from '../src/pipeline/dedupe';
import { withHash } from '../src/pipeline/normalise';
import { getRecentHashes, getRecentRoleHashes, getUnscoredJobs } from '../src/lib/db';
import type { NormalisedJob } from '../src/lib/types';

type Draft = Partial<Omit<NormalisedJob, 'content_hash' | 'role_hash'>>;

function job(draft: Draft): Promise<NormalisedJob> {
  return withHash({
    id: 'reed:1',
    source: 'reed',
    source_id: '1',
    title: 'Network Architect',
    employer: 'Ofgem',
    location_raw: null,
    remote_flag: 1,
    contract_type: 'unknown',
    salary_min: null,
    salary_max: null,
    salary_period: 'unknown',
    salary_predicted: 0,
    currency: null,
    url: 'https://example.invalid/1',
    description: '',
    description_truncated: 1,
    posted_at: null,
    ...draft,
  });
}

interface Captured {
  sql: string;
  binds: unknown[];
}

/** Enough of D1 for the read helpers: records what was asked, returns nothing. */
function fakeDb(captured: Captured[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          captured.push({ sql, binds });
          return { all: async () => ({ results: [] }) };
        },
      };
    },
  } as unknown as D1Database;
}

describe('role_hash and predicted salaries', () => {
  it('refuses to key on a salary the board guessed', async () => {
    // Indeed flags every figure predicted because it will not say which are
    // its own estimates. role_hash buckets 20k wide, so an estimate of £72k
    // and a real £78k for the same title would collapse and the real posting
    // would be dropped as a duplicate of the guess.
    const guessed = await job({ salary_min: 72000, salary_period: 'annual', salary_predicted: 1 });
    expect(guessed.role_hash).toBeNull();
  });

  it('still keys on a salary the employer stated', async () => {
    const stated = await job({ salary_min: 78000, salary_period: 'annual', salary_predicted: 0 });
    expect(stated.role_hash).not.toBeNull();
  });
});

describe('dedupe and rows that can never be scored', () => {
  it('hashes a salary-less lead identically to a salary-less board posting', async () => {
    // The collision the exclusion below exists to survive: normaliseForHash
    // buckets a null salary to 0, and boards routinely post "competitive".
    const lead = await job({ id: 'linkedin:9', source: 'linkedin', source_id: '9' });
    const board = await job({ id: 'reed:9', source: 'reed', source_id: '9' });
    expect(lead.content_hash).toBe(board.content_hash);
  });

  it('does not let a LinkedIn lead suppress the board posting behind it', async () => {
    const lead = await job({ id: 'linkedin:9', source: 'linkedin', source_id: '9' });
    const board = await job({ id: 'reed:9', source: 'reed', source_id: '9' });

    const result = await dedupe(fakeDb([]), [lead, board]);

    expect(result.fresh.map((j) => j.id)).toEqual(['linkedin:9', 'reed:9']);
    expect(result.byContentHash).toBe(0);
  });

  it('still collapses two board postings that share a content hash', async () => {
    const first = await job({ id: 'reed:9', source: 'reed', source_id: '9' });
    const second = await job({ id: 'adzuna:9', source: 'adzuna', source_id: '9' });

    const result = await dedupe(fakeDb([]), [first, second]);

    expect(result.fresh.map((j) => j.id)).toEqual(['reed:9']);
    expect(result.byContentHash).toBe(1);
  });

  it('leaves stored leads out of the hash windows an incoming posting is judged against', async () => {
    const captured: Captured[] = [];
    await getRecentHashes(fakeDb(captured), '2026-08-01T00:00:00.000Z');
    await getRecentRoleHashes(fakeDb(captured), '2026-08-01T00:00:00.000Z');

    for (const query of captured) {
      expect(query.sql).toContain('source NOT IN');
      expect(query.binds).toContain('linkedin');
    }
  });

  it('spends the unscored-jobs limit only on rows that can be scored', async () => {
    // These are dated to the alert email, so they sort to the front of this
    // query and would otherwise sit permanently at the top of its LIMIT.
    const captured: Captured[] = [];
    await getUnscoredJobs(fakeDb(captured), '2026-08-01T00:00:00.000Z');

    expect(captured[0].sql).toContain('j.source NOT IN');
    expect(captured[0].binds).toContain('linkedin');
  });
});
