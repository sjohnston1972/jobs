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

const render = (overrides: Record<string, unknown> = {}, rescorable = 0) =>
  renderSettings(defaults, overrides, rescorable);

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
});
