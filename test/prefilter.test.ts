import { describe, expect, it } from 'vitest';
import { gateLeadsAtIngest, titleGate, type Filterable } from '../src/pipeline/prefilter';
import type { Criteria } from '../src/lib/types';
import realCriteria from '../config/criteria.json';

type Job = Filterable & { source: string };

function job(draft: Partial<Job>): Job {
  return {
    title: 'Network Architect',
    description: '',
    description_truncated: 0,
    source: 'reed',
    ...draft,
  };
}

function criteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    titleAllow: ['architect', 'engineer'],
    titleBlock: ['junior'],
    bodyRequireAny: ['remote'],
    minScoreForDigest: 60,
    remoteRequirement: 'strict',
    tailorThreshold: 70,
    maxScoredPerRun: 20,
    lookbackDays: 3,
    contractTypes: [],
    seedQueries: [],
    gmailQuery: '',
    maxEmailsPerRun: 20,
    maxEmailJobsPerRun: 5,
    scoringModel: 'test-model',
    tailoringModel: 'test-model',
    ...overrides,
  };
}

describe('gateLeadsAtIngest', () => {
  it('keeps a lead whose title passes titleAllow', () => {
    const lead = job({ source: 'linkedin', title: 'Senior Network Architect' });
    const result = gateLeadsAtIngest([lead], criteria(), new Set(['linkedin']));
    expect(result.kept).toEqual([lead]);
    expect(result.dropped).toBe(0);
  });

  it('drops and counts a lead whose title matches nothing in titleAllow', () => {
    const lead = job({ source: 'linkedin', title: 'Head of Sales' });
    const result = gateLeadsAtIngest([lead], criteria(), new Set(['linkedin']));
    expect(result.kept).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it('drops a lead whose title hits titleBlock', () => {
    const lead = job({ source: 'linkedin', title: 'Junior Network Architect' });
    const result = gateLeadsAtIngest([lead], criteria(), new Set(['linkedin']));
    expect(result.kept).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it('keeps a posting from a scoreable source regardless of title', () => {
    // The asymmetry: Reed/Adzuna/Indeed get a second chance from
    // getUnscoredJobs when titleAllow widens later, so they are never
    // gated at ingest. Only unscored-source leads are gated here.
    const board = job({ source: 'reed', title: 'Head of Sales' });
    const result = gateLeadsAtIngest([board], criteria(), new Set(['linkedin']));
    expect(result.kept).toEqual([board]);
    expect(result.dropped).toBe(0);
  });

  it('returns empty and zero for empty input', () => {
    const result = gateLeadsAtIngest([], criteria(), new Set(['linkedin']));
    expect(result.kept).toEqual([]);
    expect(result.dropped).toBe(0);
  });
});

describe('titleAllow covers the singular forms', () => {
  const c = realCriteria as unknown as Criteria;

  it.each([
    'Senior Solution Architect',
    'Oracle Cloud Solution Architect',
    'Solution Architect - Infrastructure & Networks',
    'zScaler / Networking Consultant',
    'Principal Network Engineer',
    'Senior Cloud Architect',
  ])('admits %s', (title) => {
    expect(titleGate({ title, description: '', description_truncated: 0 }, c).pass).toBe(true);
  });

  it('still blocks a junior network engineer', () => {
    const verdict = titleGate(
      { title: 'Group Junior Network Engineer', description: '', description_truncated: 0 },
      c,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe('title-blocked');
  });
});
