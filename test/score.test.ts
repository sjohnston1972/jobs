import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, capsScore } from '../src/pipeline/score';
import type { Attendance, Criteria } from '../src/lib/types';

const ALL: Attendance[] = ['none', 'occasional', 'fixed', 'onsite', 'unstated'];

describe('capsScore', () => {
  it('strict caps every stated attendance requirement', () => {
    expect(capsScore('strict', 'occasional')).toBe(true);
    expect(capsScore('strict', 'fixed')).toBe(true);
    expect(capsScore('strict', 'onsite')).toBe(true);
  });

  it('mostly tolerates occasional travel but not fixed days', () => {
    expect(capsScore('mostly', 'occasional')).toBe(false);
    expect(capsScore('mostly', 'fixed')).toBe(true);
    expect(capsScore('mostly', 'onsite')).toBe(true);
  });

  it('any never caps', () => {
    for (const a of ALL) expect(capsScore('any', a)).toBe(false);
  });

  it('never caps a fully remote posting', () => {
    expect(capsScore('strict', 'none')).toBe(false);
    expect(capsScore('mostly', 'none')).toBe(false);
  });

  it('never caps an unstated posting at any level', () => {
    expect(capsScore('strict', 'unstated')).toBe(false);
    expect(capsScore('mostly', 'unstated')).toBe(false);
  });

  it('never caps when the model returned nothing', () => {
    expect(capsScore('strict', null)).toBe(false);
  });
});

function criteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    titleAllow: [], titleBlock: [], bodyRequireAny: [],
    minScoreForDigest: 40, remoteRequirement: 'mostly', tailorThreshold: 70,
    maxScoredPerRun: 40, lookbackDays: 7, contractTypes: [], seedQueries: [],
    gmailQuery: '', maxEmailsPerRun: 40, maxEmailJobsPerRun: 15,
    scoringModel: 'm', tailoringModel: 'm',
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('tells the model the configured threshold, not a hard-coded 60', () => {
    const prompt = buildSystemPrompt(criteria({ minScoreForDigest: 40 }));
    expect(prompt).toContain('40 is the threshold');
    expect(prompt).not.toContain('60 is the threshold');
  });

  it('demands fully remote under strict', () => {
    const prompt = buildSystemPrompt(criteria({ remoteRequirement: 'strict' }));
    expect(prompt).toContain('will only accept FULLY remote work');
  });

  it('allows occasional travel under mostly', () => {
    const prompt = buildSystemPrompt(criteria({ remoteRequirement: 'mostly' }));
    expect(prompt).toContain('occasional');
    expect(prompt).not.toContain('will only accept FULLY remote work');
  });

  it('does not disqualify on location under any', () => {
    const prompt = buildSystemPrompt(criteria({ remoteRequirement: 'any' }));
    expect(prompt).toContain('does not disqualify');
  });

  it('always asks for the attendance extraction', () => {
    for (const level of ['strict', 'mostly', 'any'] as const) {
      expect(buildSystemPrompt(criteria({ remoteRequirement: level }))).toContain('attendance');
    }
  });
});
