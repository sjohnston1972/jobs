import { describe, expect, it, vi } from 'vitest';
import { mergeCriteria } from '../src/lib/settings';
import * as settingsSchema from '../src/lib/settings-schema';
import type { Criteria } from '../src/lib/types';

function defaults(overrides: Partial<Criteria> = {}): Criteria {
  return {
    titleAllow: ['architect'],
    titleBlock: ['junior'],
    bodyRequireAny: ['remote'],
    minScoreForDigest: 40,
    remoteRequirement: 'mostly',
    tailorThreshold: 70,
    maxScoredPerRun: 40,
    lookbackDays: 7,
    contractTypes: [],
    seedQueries: ['network architect'],
    gmailQuery: 'newer_than:2d',
    maxEmailsPerRun: 40,
    maxEmailJobsPerRun: 15,
    scoringModel: 'test-model',
    tailoringModel: 'test-model',
    ...overrides,
  };
}

describe('mergeCriteria', () => {
  it('returns the defaults when nothing is overridden', () => {
    expect(mergeCriteria(defaults(), {})).toEqual(defaults());
  });

  it('applies an override', () => {
    const merged = mergeCriteria(defaults(), { minScoreForDigest: 55 });
    expect(merged.minScoreForDigest).toBe(55);
  });

  it('leaves every other field on the default', () => {
    const merged = mergeCriteria(defaults(), { minScoreForDigest: 55 });
    expect(merged.tailorThreshold).toBe(70);
    expect(merged.titleAllow).toEqual(['architect']);
  });

  it('falls back to the default when a stored value is invalid', () => {
    const merged = mergeCriteria(defaults(), { minScoreForDigest: 999 });
    expect(merged.minScoreForDigest).toBe(40);
  });

  it('falls back to the default when a stored list is empty', () => {
    const merged = mergeCriteria(defaults(), { titleAllow: [] });
    expect(merged.titleAllow).toEqual(['architect']);
  });

  it('ignores a key nothing reads', () => {
    const merged = mergeCriteria(defaults(), { dropTables: true }) as unknown as Record<string, unknown>;
    expect(merged.dropTables).toBeUndefined();
  });

  it('ignores contractTypes even though it is a Criteria field', () => {
    const merged = mergeCriteria(defaults(), { contractTypes: ['temp'] });
    expect(merged.contractTypes).toEqual([]);
  });

  it('normalises a valid override through its validator', () => {
    const merged = mergeCriteria(defaults(), { titleAllow: ['  Network Architect '] });
    expect(merged.titleAllow).toEqual(['network architect']);
  });

  it('isolates a throwing validator to its own field', () => {
    const originalValidator = settingsSchema.FIELD_VALIDATORS['minScoreForDigest'];
    const throwingValidator = vi.fn(() => {
      throw new Error('validator explosion');
    });
    settingsSchema.FIELD_VALIDATORS['minScoreForDigest'] = throwingValidator;

    try {
      const merged = mergeCriteria(defaults(), {
        minScoreForDigest: 55,
        tailorThreshold: 80,
      });
      // The throwing field falls back to default
      expect(merged.minScoreForDigest).toBe(40);
      // Other overrides still apply
      expect(merged.tailorThreshold).toBe(80);
    } finally {
      // Restore the original validator
      settingsSchema.FIELD_VALIDATORS['minScoreForDigest'] = originalValidator;
    }
  });
});
