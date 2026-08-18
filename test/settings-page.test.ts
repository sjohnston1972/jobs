import { describe, expect, it } from 'vitest';
import { renderSettings } from '../src/web/settings';
import type { Criteria } from '../src/lib/types';

const defaults = {
  titleAllow: ['network architect'], titleBlock: [], bodyRequireAny: [],
  minScoreForDigest: 40, remoteRequirement: 'mostly', tailorThreshold: 70,
  maxScoredPerRun: 40, lookbackDays: 7, contractTypes: [], seedQueries: ['x'],
  gmailQuery: 'q', maxEmailsPerRun: 40, maxEmailJobsPerRun: 15,
  scoringModel: 'm', tailoringModel: 't',
} as Criteria;

// Mirrors mergeCriteria: the page is passed loadCriteria's result, which is
// the file defaults with overrides merged on top, not the raw overrides row.
const render = (overrides: Record<string, unknown> = {}, rescorable = 0) =>
  renderSettings(defaults, { ...defaults, ...overrides }, overrides, rescorable);

describe('renderSettings', () => {
  it('shows the effective value for an overridden field', () => {
    expect(render({ minScoreForDigest: 55 })).toContain('value="55"');
  });

  it('marks an overridden field as overridden', () => {
    expect(render({ minScoreForDigest: 55 })).toMatch(/overridden/i);
  });

  it('shows the file default alongside it', () => {
    expect(render({ minScoreForDigest: 55 })).toContain('default: 40');
  });

  it('offers no control for contractTypes', () => {
    expect(render()).not.toContain('contractTypes');
  });

  it('shows both thresholds together', () => {
    const html = render();
    expect(html).toContain('minScoreForDigest');
    expect(html).toContain('tailorThreshold');
  });

  it('escapes a stored value so it cannot break out of the attribute', () => {
    expect(render({ gmailQuery: '" onerror="alert(1)' })).not.toContain('onerror="alert(1)"');
  });

  it('reports the rescorable count', () => {
    expect(render({}, 47)).toContain('47');
  });

  it('shows the loaded effective value, not the raw overrides row, when they diverge', () => {
    // Simulates a row written directly with wrangler d1 execute (or one from
    // before a validator tightened): the overrides table says 999, but the
    // merged/validated criteria actually in effect is what every run uses.
    const html = renderSettings(defaults, { ...defaults, minScoreForDigest: 40 }, { minScoreForDigest: 999 }, 0);
    expect(html).toContain('value="40"');
    expect(html).not.toContain('value="999"');
    // The badge still reflects that a row exists, independent of its content.
    expect(html).toMatch(/overridden/i);
  });
});
