import { describe, expect, it } from 'vitest';
import { FIELD_VALIDATORS, SETTABLE_KEYS, isSettableKey } from '../src/lib/settings-schema';

function check(key: string, value: unknown) {
  return FIELD_VALIDATORS[key](value);
}

describe('numeric fields', () => {
  it('accepts an in-range integer', () => {
    expect(check('minScoreForDigest', 40)).toEqual({ ok: true, value: 40 });
  });

  it('coerces a numeric string, because form posts arrive as strings', () => {
    expect(check('minScoreForDigest', '40')).toEqual({ ok: true, value: 40 });
  });

  it('rejects a value above the range', () => {
    expect(check('minScoreForDigest', 101).ok).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(check('lookbackDays', 2.5).ok).toBe(false);
  });

  it('refuses a zero that would silently disable a stage', () => {
    expect(check('maxScoredPerRun', 0).ok).toBe(false);
    expect(check('maxEmailsPerRun', 0).ok).toBe(false);
    expect(check('maxEmailJobsPerRun', 0).ok).toBe(false);
  });

  it('rejects null, which Number() coerces to 0', () => {
    expect(check('minScoreForDigest', null).ok).toBe(false);
  });

  it('rejects undefined', () => {
    expect(check('minScoreForDigest', undefined).ok).toBe(false);
  });

  it('rejects boolean values', () => {
    expect(check('minScoreForDigest', true).ok).toBe(false);
    expect(check('minScoreForDigest', false).ok).toBe(false);
  });

  it('rejects arrays, which Number() coerces', () => {
    expect(check('minScoreForDigest', [5]).ok).toBe(false);
    expect(check('minScoreForDigest', []).ok).toBe(false);
  });

  it('rejects objects', () => {
    expect(check('minScoreForDigest', {}).ok).toBe(false);
  });

  it('rejects numeric strings with trailing garbage', () => {
    expect(check('minScoreForDigest', '40abc').ok).toBe(false);
  });
});

describe('list fields', () => {
  it('trims entries and drops blanks', () => {
    expect(check('titleAllow', ['  architect ', '', 'engineer'])).toEqual({
      ok: true,
      value: ['architect', 'engineer'],
    });
  });

  it('refuses an empty titleAllow, which would admit nothing', () => {
    expect(check('titleAllow', []).ok).toBe(false);
  });

  it('refuses an empty seedQueries, which would fetch nothing', () => {
    expect(check('seedQueries', []).ok).toBe(false);
  });

  it('allows an empty titleBlock', () => {
    expect(check('titleBlock', [])).toEqual({ ok: true, value: [] });
  });

  it('allows an empty bodyRequireAny', () => {
    expect(check('bodyRequireAny', [])).toEqual({ ok: true, value: [] });
  });

  it('rejects a non-array', () => {
    expect(check('titleAllow', 'architect').ok).toBe(false);
  });

  it('rejects array elements that are not strings', () => {
    expect(check('titleAllow', [{}]).ok).toBe(false);
    expect(check('titleAllow', [5]).ok).toBe(false);
  });

  it('normalizes valid string arrays', () => {
    expect(check('titleAllow', ['  Network Architect '])).toEqual({
      ok: true,
      value: ['network architect'],
    });
  });
});

describe('enumerated and string fields', () => {
  it('accepts a known remote requirement', () => {
    expect(check('remoteRequirement', 'mostly')).toEqual({ ok: true, value: 'mostly' });
  });

  it('rejects an unknown remote requirement', () => {
    expect(check('remoteRequirement', 'sometimes').ok).toBe(false);
  });

  it('rejects an empty model name', () => {
    expect(check('scoringModel', '   ').ok).toBe(false);
  });
});

describe('the settable set', () => {
  it('does not offer contractTypes, which nothing reads', () => {
    expect(isSettableKey('contractTypes')).toBe(false);
    expect(SETTABLE_KEYS).not.toContain('contractTypes');
  });

  it('rejects an unknown key', () => {
    expect(isSettableKey('dropTables')).toBe(false);
  });
});
