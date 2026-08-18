/**
 * Validators for every field the settings page may change.
 *
 * Applied twice: once when a value is saved, so a bad value is refused with a
 * reason, and again when it is read back, so a row written by an older version
 * cannot break a run. The read path never throws — see loadCriteria.
 *
 * contractTypes is deliberately absent. It is declared in Criteria and present
 * in criteria.json but referenced nowhere in src/, so a control for it would
 * advertise an effect it does not have.
 */

export type FieldResult = { ok: true; value: unknown } | { ok: false; error: string };

/** `min: 1` on the per-run caps: zero disables a stage and looks exactly like a broken run. */
function intIn(min: number, max: number) {
  return (v: unknown): FieldResult => {
    const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
    if (!Number.isInteger(n)) return { ok: false, error: 'must be a whole number' };
    if (n < min || n > max) return { ok: false, error: `must be between ${min} and ${max}` };
    return { ok: true, value: n };
  };
}

function stringList(allowEmpty: boolean) {
  return (v: unknown): FieldResult => {
    if (!Array.isArray(v)) return { ok: false, error: 'must be a list' };
    const items = v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    if (!allowEmpty && items.length === 0) return { ok: false, error: 'must have at least one entry' };
    return { ok: true, value: items };
  };
}

function memberOf(allowed: readonly string[]) {
  return (v: unknown): FieldResult =>
    typeof v === 'string' && allowed.includes(v)
      ? { ok: true, value: v }
      : { ok: false, error: `must be one of: ${allowed.join(', ')}` };
}

function nonEmptyString(v: unknown): FieldResult {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? { ok: true, value: s } : { ok: false, error: 'must not be empty' };
}

export const FIELD_VALIDATORS: Record<string, (v: unknown) => FieldResult> = {
  titleAllow: stringList(false),
  titleBlock: stringList(true),
  bodyRequireAny: stringList(true),
  seedQueries: stringList(false),
  minScoreForDigest: intIn(0, 100),
  tailorThreshold: intIn(0, 100),
  maxScoredPerRun: intIn(1, 500),
  maxEmailsPerRun: intIn(1, 200),
  maxEmailJobsPerRun: intIn(1, 100),
  lookbackDays: intIn(1, 30),
  remoteRequirement: memberOf(['strict', 'mostly', 'any']),
  gmailQuery: nonEmptyString,
  scoringModel: nonEmptyString,
  tailoringModel: nonEmptyString,
};

export const SETTABLE_KEYS: string[] = Object.keys(FIELD_VALIDATORS);

export function isSettableKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELD_VALIDATORS, key);
}
