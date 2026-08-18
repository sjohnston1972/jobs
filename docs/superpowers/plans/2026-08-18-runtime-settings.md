# Runtime-Adjustable Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every field of `Criteria` adjustable at runtime from a settings page in the portal, and replace the hard-coded fully-remote rule with a three-level toggle, so the tuning that decides whether the digest fires can be changed without a deploy.

**Architecture:** `config/criteria.json` stays the defaults. A new sparse `settings` table in D1 holds only fields actually overridden through the UI. `loadCriteria(db)` merges the two and is called once per run, so a run is internally consistent. The remote policy moves from a `remote_confidence`-based cap to a new factual `attendance` field the model extracts, which lets the middle level exist.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), vitest, wrangler.

**Spec:** `docs/superpowers/specs/2026-08-18-runtime-settings-design.md`

## Global Constraints

- Run `npm run typecheck` before every commit. It is `tsc --noEmit` and it is the only thing standing between a bad type and a broken deploy.
- Tests are vitest, run with `npm test`. Test files live in `test/` and import from `../src/...`.
- `contractTypes` is dead config — declared in `Criteria`, referenced nowhere in `src/`. Do not add a validator, a UI control, or a test for it.
- A bad setting must never stop the pipeline. Every read path falls back to the file default and logs; it never throws.
- Migrations are numbered files in `migrations/`, applied by hand with `npx wrangler d1 execute job-monitor --remote --file=...`. `schema.sql` is the full shape for a fresh database, not a migration runner — update both.
- `BUILD` in `src/index.ts` is bumped by hand and reported by `/health`. Deploys are not instant; check `build` before trusting a test run.
- Log lines follow the existing style: `settings: ...`, matching `dedupe: ...` and `prefilter: ...`.

---

### Task 1: Migration for the settings table and the attendance column

**Files:**
- Create: `migrations/0003_settings_and_attendance.sql`
- Modify: `schema.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: a `settings` table (`key TEXT PRIMARY KEY`, `value TEXT NOT NULL`, `updated_at TEXT NOT NULL`) and a nullable `scores.attendance TEXT` column. Tasks 4 and 5 depend on both existing.

- [ ] **Step 1: Write the migration**

Create `migrations/0003_settings_and_attendance.sql`:

```sql
-- Sparse overrides for config/criteria.json. Only fields actually changed in
-- the portal get a row; everything else continues to track the bundled file,
-- so editing criteria.json and redeploying still works for anything untouched.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,   -- a Criteria field name
  value      TEXT NOT NULL,      -- JSON-encoded scalar or array
  updated_at TEXT NOT NULL
);

-- What the posting says about being in an office, as a fact rather than a
-- judgement. The remote policy caps on this, so the levels are decided in code
-- rather than trusted to the model.
ALTER TABLE scores ADD COLUMN attendance TEXT;
```

- [ ] **Step 2: Apply it to the remote database**

Run:

```bash
npx wrangler d1 execute job-monitor --remote --file=migrations/0003_settings_and_attendance.sql
```

Expected: two statements executed, no error.

- [ ] **Step 3: Verify both landed**

Run:

```bash
npx wrangler d1 execute job-monitor --remote --command "SELECT COUNT(*) FROM settings"
npx wrangler d1 execute job-monitor --remote --command "SELECT attendance FROM scores LIMIT 1"
```

Expected: the first returns 0; the second returns a row with `attendance: null`. Neither errors.

- [ ] **Step 4: Update `schema.sql` to match**

Add the `settings` table verbatim from the migration, and add `attendance TEXT` to the `scores` table definition immediately after `seniority_fit`:

```sql
  seniority_fit     TEXT,                -- below | match | above
  attendance        TEXT,                -- none | occasional | fixed | onsite | unstated
```

- [ ] **Step 5: Commit**

```bash
git add migrations/0003_settings_and_attendance.sql schema.sql
git commit -m "Add settings table and scores.attendance column"
```

---

### Task 2: Seed the tuning decisions as file defaults

This task delivers the immediate fix on its own: the widened title gate and the lower threshold. `remoteRequirement` is added to the type and the JSON here but is not read by anything until Task 5.

**Files:**
- Modify: `config/criteria.json`
- Modify: `src/lib/types.ts:142-160`
- Modify: `test/prefilter.test.ts:17-34`
- Test: `test/prefilter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Criteria.remoteRequirement: RemoteRequirement`, and the exported type `RemoteRequirement = 'strict' | 'mostly' | 'any'` from `src/lib/types.ts`. Tasks 3, 5, 6 and 8 all use it.

- [ ] **Step 1: Write the failing test**

Add to `test/prefilter.test.ts`, using the file's existing `job()` and `criteria()` helpers — but note this test deliberately uses the *real* criteria file, not the helper, because the defect being fixed is in that file:

```ts
import realCriteria from '../config/criteria.json';
import { titleGate } from '../src/pipeline/prefilter';

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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/prefilter.test.ts`
Expected: FAIL — every `admits` case fails with `pass` being `false`, because `titleAllow` carries the plural `"solutions architect"` and has no `network engineer` entry.

- [ ] **Step 3: Widen `titleAllow` and drop the threshold**

In `config/criteria.json`, add these six entries to `titleAllow` (keep the existing thirteen):

```json
    "solution architect",
    "network engineer",
    "networking consultant",
    "cloud architect",
    "platform architect",
    "network security"
```

Change `minScoreForDigest` from `60` to `40`, and add the new field after it:

```json
  "minScoreForDigest": 40,
  "remoteRequirement": "mostly",
```

- [ ] **Step 4: Add the type**

In `src/lib/types.ts`, add the union near the other score unions:

```ts
/** How much office attendance the candidate will tolerate. Enforced in code, not just the prompt. */
export type RemoteRequirement = 'strict' | 'mostly' | 'any';
```

and add the field to `Criteria`, after `minScoreForDigest`:

```ts
  minScoreForDigest: number;
  /** Selects the rule 3 wording in the scoring prompt and the score cap policy. */
  remoteRequirement: RemoteRequirement;
```

- [ ] **Step 5: Fix the test helper the new required field breaks**

In `test/prefilter.test.ts`, the `criteria()` helper builds a full `Criteria` and will now fail to typecheck. Add to it, after `minScoreForDigest`:

```ts
    minScoreForDigest: 60,
    remoteRequirement: 'strict',
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add config/criteria.json src/lib/types.ts test/prefilter.test.ts
git commit -m "Widen titleAllow to the singular forms and drop the digest threshold to 40"
```

---

### Task 3: Field validators

Pure functions, no database. This is what stops a setting from silently stopping the pipeline.

**Files:**
- Create: `src/lib/settings-schema.ts`
- Test: `test/settings-schema.test.ts`

**Interfaces:**
- Consumes: `Criteria`, `RemoteRequirement` from `src/lib/types.ts` (Task 2).
- Produces:
  - `type FieldResult = { ok: true; value: unknown } | { ok: false; error: string }`
  - `const FIELD_VALIDATORS: Record<string, (v: unknown) => FieldResult>`
  - `function isSettableKey(key: string): boolean`
  - `const SETTABLE_KEYS: string[]`

  Tasks 4 and 8 both consume all four.

- [ ] **Step 1: Write the failing test**

Create `test/settings-schema.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/settings-schema.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/settings-schema"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/settings-schema.ts`:

```ts
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

function intIn(min: number, max: number) {
  return (v: unknown): FieldResult => {
    const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
    if (!Number.isInteger(n)) return { ok: false, error: 'must be a whole number' };
    if (n < min || n > max) return { ok: false, error: `must be between ${min} and ${max}` };
    return { ok: true, value: n };
  };
}

/** `min: 1` on the per-run caps: zero disables a stage and looks exactly like a broken run. */
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
```

Note `stringList` lowercases. Both gates already lowercase before comparing (`titleGate` does `title.toLowerCase()` and `criteria.titleAllow.find((term) => title.includes(term.toLowerCase()))`), so storing lowercase keeps the UI honest about what will actually be matched. `seedQueries` is also lowercased; Reed and Adzuna search case-insensitively.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/settings-schema.test.ts && npm run typecheck`
Expected: all PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings-schema.ts test/settings-schema.test.ts
git commit -m "Add validators for every settable criteria field"
```

---

### Task 4: Storage and the merge layer

**Files:**
- Create: `src/lib/settings.ts`
- Modify: `src/lib/config.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: `FIELD_VALIDATORS`, `isSettableKey` (Task 3); the `settings` table (Task 1).
- Produces:
  - `readOverrides(db: D1Database): Promise<Record<string, unknown>>`
  - `setOverride(db: D1Database, key: string, value: unknown): Promise<void>`
  - `clearOverride(db: D1Database, key: string): Promise<void>`
  - `mergeCriteria(defaults: Criteria, rows: Record<string, unknown>): Criteria`
  - `loadCriteria(db: D1Database): Promise<Criteria>` from `src/lib/config.ts`

  Tasks 7, 8 and 9 consume these.

`mergeCriteria` is exported separately from `loadCriteria` precisely so the merge rules can be tested without a database.

- [ ] **Step 1: Write the failing test**

Create `test/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeCriteria } from '../src/lib/settings';
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
    const merged = mergeCriteria(defaults(), { dropTables: true }) as Record<string, unknown>;
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
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/settings"`.

- [ ] **Step 3: Write the storage and merge module**

Create `src/lib/settings.ts`:

```ts
import { FIELD_VALIDATORS, isSettableKey } from './settings-schema';
import type { Criteria } from './types';

/**
 * Sparse overrides over config/criteria.json.
 *
 * Only fields actually changed in the portal have a row. A field never touched
 * still tracks the bundled file, so editing criteria.json and redeploying —
 * the process CLAUDE.md documents — keeps working for everything else. Reset
 * deletes the row rather than writing the current default into it, so a field
 * can always be handed back to the file.
 */

interface SettingRow {
  key: string;
  value: string;
}

export async function readOverrides(db: D1Database): Promise<Record<string, unknown>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<SettingRow>();
  const out: Record<string, unknown> = {};
  for (const row of results ?? []) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // A row that is not JSON is skipped rather than thrown. mergeCriteria
      // would drop it anyway; this keeps the failure to one field.
      console.log(`settings: ignoring unparseable value for ${row.key}`);
    }
  }
  return out;
}

export async function setOverride(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}

export async function clearOverride(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

/**
 * Pure, and exported separately from loadCriteria so the precedence rules can
 * be tested without a database. An invalid stored value is logged and dropped,
 * never thrown: a setting must not be able to stop a run.
 */
export function mergeCriteria(defaults: Criteria, rows: Record<string, unknown>): Criteria {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, raw] of Object.entries(rows)) {
    if (!isSettableKey(key)) {
      console.log(`settings: ignoring unknown key ${key}`);
      continue;
    }
    const result = FIELD_VALIDATORS[key](raw);
    if (!result.ok) {
      console.log(`settings: ignoring invalid ${key} (${result.error}), using default`);
      continue;
    }
    merged[key] = result.value;
  }
  return merged as Criteria;
}
```

- [ ] **Step 4: Add `loadCriteria` to the config module**

Replace the body of `src/lib/config.ts` with:

```ts
import criteriaJson from '../../config/criteria.json';
import profileMd from '../../config/profile.md';
import { mergeCriteria, readOverrides } from './settings';
import type { Criteria } from './types';

/**
 * Both files are bundled into the Worker at build time. `criteria` is the
 * defaults; the settings table overrides individual fields at runtime. Use
 * loadCriteria wherever behaviour depends on tuning — `criteria` alone is only
 * correct for showing the user what "default" means.
 */
export const criteria = criteriaJson as unknown as Criteria;
export const profile: string = profileMd;

export async function loadCriteria(db: D1Database): Promise<Criteria> {
  try {
    return mergeCriteria(criteria, await readOverrides(db));
  } catch (err) {
    // A dead settings table must not take the run with it.
    console.log(`settings: read failed, using file defaults — ${String(err)}`);
    return criteria;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test && npm run typecheck`
Expected: all PASS, tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings.ts src/lib/config.ts test/settings.test.ts
git commit -m "Add sparse settings overrides merged over the file defaults"
```

---

### Task 5: The attendance field and the cap policy

**Files:**
- Modify: `src/pipeline/score.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/db.ts` (`insertScore`, and the `SCORED_SELECT` column list)
- Test: `test/score.test.ts`

**Interfaces:**
- Consumes: `RemoteRequirement` (Task 2); `scores.attendance` (Task 1).
- Produces:
  - `type Attendance = 'none' | 'occasional' | 'fixed' | 'onsite' | 'unstated'` from `src/lib/types.ts`
  - `ScoreResult.attendance: Attendance | null`
  - `function capsScore(requirement: RemoteRequirement, attendance: Attendance | null): boolean` from `src/pipeline/score.ts`

  Task 6 consumes `Attendance`; Task 8 displays the policy.

- [ ] **Step 1: Write the failing test**

Create `test/score.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { capsScore } from '../src/pipeline/score';
import type { Attendance } from '../src/lib/types';

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
```

The `unstated` cases matter. A posting silent on working location is exactly the truncated-excerpt case the body gate already defers to the scorer; capping it would reject genuinely remote roles for the accident of where a board excerpt ended.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/score.test.ts`
Expected: FAIL — `capsScore` is not exported from `../src/pipeline/score`.

- [ ] **Step 3: Add the type**

In `src/lib/types.ts`, beside the other score unions:

```ts
/** What the posting states about office attendance. A fact, not a judgement. */
export type Attendance = 'none' | 'occasional' | 'fixed' | 'onsite' | 'unstated';
```

and add to `ScoreResult`, after `seniority_fit`:

```ts
  attendance: Attendance | null;
```

and the same line to `ScoredJob`, so the portal and digest can read it.

- [ ] **Step 4: Implement the policy and wire it into `scoreJob`**

In `src/pipeline/score.ts`, add the import of `Attendance` and `RemoteRequirement` to the existing type import, then add:

```ts
/**
 * Rule 3 enforced in code rather than only asked for in the prompt. Models
 * drift on it — an early run scored a "98% remote, occasional travel to
 * London" role at 72 — so the level decides the cap here, from a fact the
 * model extracted rather than a judgement it made.
 *
 * `unstated` never caps at any level: a posting silent on working location is
 * the truncated-excerpt case the body gate defers here on purpose, and capping
 * it would reject genuinely remote roles on where an excerpt happened to end.
 */
export function capsScore(
  requirement: RemoteRequirement,
  attendance: Attendance | null,
): boolean {
  if (requirement === 'any') return false;
  if (attendance === null || attendance === 'none' || attendance === 'unstated') return false;
  if (requirement === 'strict') return true;
  return attendance === 'fixed' || attendance === 'onsite';
}
```

Add `attendance` to `SCHEMA_HINT`, after `seniority_fit`:

```
  "attendance": "none|occasional|fixed|onsite|unstated",
```

Add it to `SCORE_SCHEMA.properties`:

```ts
    attendance: {
      type: 'string',
      enum: ['none', 'occasional', 'fixed', 'onsite', 'unstated'],
    },
```

and to its `required` array. Add `attendance?: unknown;` to `RawScore`.

Replace the existing cap block (currently `if (confidence === 'low' && finalScore >= 40)`) with:

```ts
  const attendance = oneOf<Attendance>(parsed.attendance, [
    'none', 'occasional', 'fixed', 'onsite', 'unstated',
  ]);

  let finalScore = score;
  let reasonSuffix = '';
  if (score >= 40 && capsScore(criteria.remoteRequirement, attendance)) {
    finalScore = 39;
    reasonSuffix = ` [capped from ${score}: attendance is ${attendance}, requirement is ${criteria.remoteRequirement}]`;
  }
```

and add `attendance,` to the returned `ScoreResult` object.

Every early return in `scoreJob` (the `callClaude` catch and the unparseable branch) also builds a `ScoreResult` and needs `attendance: null` added, or the file will not typecheck.

- [ ] **Step 5: Persist and read it back**

In `src/lib/db.ts`, `insertScore`: add `attendance` to the column list and `result.attendance` to the binds, keeping the positions aligned — it goes after `seniority_fit` in both. Add a tenth `?` to the `VALUES` list; miscounting these is the easiest way to write `reason` into the `model` column.

The select is generated, not literal. Add `s.attendance` to `selectWith` (around `src/lib/db.ts:220`), which feeds both `SCORED_SELECT` and `LEADS_SELECT`:

```ts
  SELECT j.*, s.score, s.remote_confidence, s.remote_evidence, s.ir35_signal,
         s.seniority_fit, s.attendance, s.reason, s.red_flags, s.scored_at,
         a.status, a.updated_at AS status_updated_at, a.notes
```

The mapping goes in `toPortalJob`, not `toScoredJob` — the latter is only a cast over the former:

```ts
    attendance: (row.attendance as Attendance | null) ?? null,
```

Add `attendance: Attendance | null` to `PortalJob` as well as `ScoreResult`, or `toPortalJob` will not typecheck.

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run typecheck`
Expected: all PASS, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/score.ts src/lib/types.ts src/lib/db.ts test/score.test.ts
git commit -m "Cap on extracted attendance instead of remote confidence"
```

---

### Task 6: Interpolate the prompt

The threshold and the remote policy are currently *told* to the model as literals. Changing the config without changing the prompt would leave the model working to the old rules.

**Files:**
- Modify: `src/pipeline/score.ts`
- Test: `test/score.test.ts`

**Interfaces:**
- Consumes: `Criteria`, `RemoteRequirement` (Task 2); `capsScore` (Task 5).
- Produces: `function buildSystemPrompt(criteria: Criteria): string` from `src/pipeline/score.ts`. Nothing later consumes it; `scoreJob` calls it internally.

- [ ] **Step 1: Write the failing test**

Add to `test/score.test.ts`:

```ts
import { buildSystemPrompt } from '../src/pipeline/score';
import type { Criteria } from '../src/lib/types';

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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/score.test.ts`
Expected: FAIL — `buildSystemPrompt` is not exported.

- [ ] **Step 3: Replace the constant with a builder**

In `src/pipeline/score.ts`, delete `const SYSTEM_PROMPT = ...` and add:

```ts
/**
 * Rule 3 is selected by the configured level, and rule 1 quotes the configured
 * threshold. Both were literals until the threshold became adjustable, at which
 * point a prompt saying "60 is the threshold" while the digest used 40 would
 * have had the model scoring to a bar nobody was measuring against.
 */
const REMOTE_RULES: Record<RemoteRequirement, string> = {
  strict: `3. The candidate will only accept FULLY remote work. ANY stated
   requirement to attend an office or travel disqualifies — there is no
   threshold below which it becomes acceptable. Treat "98% remote",
   "mostly remote", "occasional travel" and "travel as required" as
   disqualifying, exactly as you would treat "hybrid".`,

  mostly: `3. The candidate accepts remote work with occasional travel, and
   rejects any fixed attendance pattern. "98% remote with occasional travel",
   "very occasional travel" and "travel as required" are ACCEPTABLE and should
   not cost significant points. "Hybrid", "2 days per week in the office",
   "3 days on site" and a named office given as the place of work are NOT
   acceptable and should score poorly.`,

  any: `3. Working location does not disqualify a posting. Note it and let it
   cost a few points where it is inconvenient, but judge the role primarily on
   its technical and seniority fit.`,
};

const ATTENDANCE_RULE = `4. Extract what the posting STATES about office attendance into
   \`attendance\`. This is a fact, not a judgement — report what the text says
   and nothing more:
     - "none"       fully remote, no attendance of any kind mentioned as required
     - "occasional" ad-hoc, rare or as-required travel; no fixed pattern
     - "fixed"      a recurring pattern — hybrid, N days per week, weekly on site
     - "onsite"     the work is based at a named location, remote not offered
     - "unstated"   the posting never addresses working location
   Use "unstated" when the text is silent. Do not infer "none" from silence.`;

export function buildSystemPrompt(criteria: Criteria): string {
  return `You assess UK job postings for one specific candidate and return JSON only.

Rules you must follow:

1. Score conservatively. Prefer a low score to a generous one. An inbox of false
   positives is worse than an empty digest. ${criteria.minScoreForDigest} is the
   threshold for "worth reading"; do not drift upward to be helpful.

2. The job board's own "remote" flag is unreliable and is not shown to you.
   Judge remoteness ONLY from wording in the description, and quote the exact
   phrase you relied on in remote_evidence. If nothing in the text addresses
   working location, remote_confidence is "low" and remote_evidence is null.

${REMOTE_RULES[criteria.remoteRequirement]}

${ATTENDANCE_RULE}

5. For contract postings, extract any IR35 statement into ir35_signal. The
   candidate intends to trade through a limited company, so "inside" is a red
   flag and should cost significant points. Use "n/a" for permanent roles and
   "unstated" when a contract posting is silent on it.

6. seniority_fit compares the posting's level to the candidate's. "below" means
   the posting is more junior than the candidate; that should cost points.

7. red_flags is a short array of specific concerns. Each entry is a terse
   label of at most six words, not a sentence and not an explanation —
   "inside IR35", "office attendance required", "salary below level",
   "12-month fixed term". The reasoning belongs in the reason field. Use an
   empty array when there are none, and do not invent concerns.

Output a single JSON object and nothing else. No prose, no markdown fences.`;
}
```

In `scoreJob`, change `system: SYSTEM_PROMPT` to `system: buildSystemPrompt(criteria)`.

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: all PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/score.ts test/score.test.ts
git commit -m "Build the scoring prompt from the configured threshold and remote level"
```

---

### Task 7: Load the merged criteria once per run

**Files:**
- Modify: `src/index.ts` (`runPipeline`, and the `fetch` handler's uses at lines ~415, ~435, ~454)

**Interfaces:**
- Consumes: `loadCriteria` (Task 4).
- Produces: nothing new. This is the wiring that makes Tasks 3–6 take effect.

- [ ] **Step 1: Load the snapshot at the top of `runPipeline`**

In `src/index.ts`, change the import:

```ts
import { criteria as defaultCriteria, loadCriteria, profile } from './lib/config';
```

At the top of `runPipeline`, immediately after `const runId = await db.startRun(env.DB);`:

```ts
  // Loaded once and passed through every stage. Stage 4 chooses what to score
  // and stage 6 chooses what to digest, both from minScoreForDigest — a
  // settings change landing between them must not make the two disagree.
  const criteria = await loadCriteria(env.DB);
```

Every existing `criteria.` reference inside `runPipeline` now resolves to this local constant, so no other line in the function changes.

- [ ] **Step 2: Load it per request in the fetch handler**

Three routes read `criteria` at module scope today. In `/digest/preview`, add before the first use:

```ts
        const criteria = await loadCriteria(env.DB);
```

Do the same in `/gmail/preview`. For the portal route at `/`, load it and pass it to `renderPortal` in place of the module import.

Anywhere the *defaults* are genuinely wanted rather than the effective values, use `defaultCriteria` — as of this task, nowhere does, but Task 8 will.

- [ ] **Step 3: Verify no module-scope use of the old import remains**

Run:

```bash
grep -n "criteria\." src/index.ts | grep -v "defaultCriteria"
```

Expected: every hit is inside `runPipeline` or inside a route handler that has its own `const criteria = await loadCriteria(env.DB)` above it. If any hit is at module scope, it is reading defaults and ignoring overrides — fix it.

- [ ] **Step 4: Typecheck and test**

Run: `npm test && npm run typecheck`
Expected: all PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "Load merged criteria once per run and per request"
```

---

### Task 8: The settings page

**Files:**
- Create: `src/web/settings.ts`
- Modify: `src/index.ts` (two new routes)
- Test: `test/settings-page.test.ts`

**Interfaces:**
- Consumes: `SETTABLE_KEYS`, `FIELD_VALIDATORS`, `isSettableKey` (Task 3); `readOverrides`, `setOverride`, `clearOverride` (Task 4); `layout` from `src/web/portal.ts`.
- Produces: `renderSettings(defaults: Criteria, overrides: Record<string, unknown>, rescorable: number): string` from `src/web/settings.ts`.

The `rescorable` count is rendered here but not computed until Task 9, so this task's route passes `0`. That keeps the two tasks independently shippable — a settings page showing "0 scored jobs" is wrong but harmless, and Task 9 replaces it in one line.

- [ ] **Step 1: Write the failing test**

Create `test/settings-page.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/settings-page.test.ts`
Expected: FAIL — `Failed to resolve import "../src/web/settings"`.

- [ ] **Step 3: Build the page**

Create `src/web/settings.ts`. Note the two import paths — `layout` is in `src/web/portal.ts` but `escapeHtml` is exported from `src/pipeline/digest.ts` (see `src/index.ts:13`), not from portal. Import it rather than writing a second one.

```ts
import { escapeHtml } from '../pipeline/digest';
import { layout } from './portal';
import { SETTABLE_KEYS } from '../lib/settings-schema';
import type { Criteria } from '../lib/types';

type Group = { title: string; note?: string; keys: string[] };

const GROUPS: Group[] = [
  {
    title: 'Scoring',
    // Shown together on purpose: the tailor link needs the higher of the two,
    // and it sat at 70 while the highest score ever awarded was 42, so it had
    // never once appeared. Lowering the digest threshold alone does not fix it.
    note: 'A job needs minScoreForDigest to reach the email, and tailorThreshold to get a tailor link.',
    keys: ['minScoreForDigest', 'tailorThreshold', 'remoteRequirement'],
  },
  { title: 'Volume', keys: ['maxScoredPerRun', 'maxEmailsPerRun', 'maxEmailJobsPerRun', 'lookbackDays'] },
  { title: 'Keywords', keys: ['titleAllow', 'titleBlock', 'bodyRequireAny', 'seedQueries'] },
  { title: 'Plumbing', keys: ['gmailQuery', 'scoringModel', 'tailoringModel'] },
];

const REMOTE_LEVELS: Array<[string, string]> = [
  ['strict', 'Strict — any attendance requirement caps the score at 39'],
  ['mostly', 'Mostly remote — occasional travel is fine; fixed days or on-site cap at 39'],
  ['any', 'Any — nothing is capped; remoteness only costs points'],
];

function control(key: string, effective: unknown, isOverridden: boolean): string {
  if (key === 'remoteRequirement') {
    const opts = REMOTE_LEVELS.map(
      ([v, label]) =>
        `<option value="${escapeHtml(v)}"${v === effective ? ' selected' : ''}>${escapeHtml(label)}</option>`,
    ).join('');
    return `<select data-key="${escapeHtml(key)}">${opts}</select>`;
  }
  if (Array.isArray(effective)) {
    const items = effective
      .map(
        (term) =>
          `<li>${escapeHtml(String(term))} <button data-remove="${escapeHtml(key)}" ` +
          `data-term="${escapeHtml(String(term))}">remove</button></li>`,
      )
      .join('');
    return `<ul>${items}</ul><input data-add="${escapeHtml(key)}" placeholder="add term">`;
  }
  return `<input data-key="${escapeHtml(key)}" value="${escapeHtml(String(effective))}">`;
}

export function renderSettings(
  defaults: Criteria,
  overrides: Record<string, unknown>,
  rescorable: number,
): string {
  const rows = GROUPS.map((group) => {
    // Filtered against SETTABLE_KEYS so a field with no validator — contractTypes —
    // cannot be rendered even if someone adds it to a group by mistake.
    const fields = group.keys
      .filter((key) => SETTABLE_KEYS.includes(key))
      .map((key) => {
        const isOverridden = Object.prototype.hasOwnProperty.call(overrides, key);
        const effective = isOverridden ? overrides[key] : (defaults as Record<string, unknown>)[key];
        const badge = isOverridden
          ? `<span class="badge">overridden</span>
             <button data-reset="${escapeHtml(key)}">Reset to default</button>`
          : '';
        const dflt = escapeHtml(
          Array.isArray((defaults as Record<string, unknown>)[key])
            ? ((defaults as Record<string, unknown>)[key] as unknown[]).join(', ')
            : String((defaults as Record<string, unknown>)[key]),
        );
        return `<div class="field">
            <label>${escapeHtml(key)} ${badge}</label>
            ${control(key, effective, isOverridden)}
            <p class="default">default: ${dflt}</p>
          </div>`;
      })
      .join('');
    const note = group.note ? `<p class="note">${escapeHtml(group.note)}</p>` : '';
    return `<section><h2>${escapeHtml(group.title)}</h2>${note}${fields}</section>`;
  }).join('');

  const rescore = `<section><h2>Rescore</h2>
      <p>${rescorable} scored jobs are inside the current lookback window.
         Re-judging them costs ${rescorable} Claude calls.</p>
      <button id="rescore">Rescore these ${rescorable}</button>
    </section>`;

  return layout('Settings — Job Monitor', `<h1>Settings</h1>${rows}${rescore}`, SETTINGS_SCRIPT);
}
```

`SETTINGS_SCRIPT` is an inline script posting to `/api/settings` on change (`{key, value}`), on remove/add for list fields (posting the whole resulting array), and `{key, reset: true}` for the reset button; and to `/api/rescore` for the rescore button. Follow the fetch pattern the portal already uses for `/api/status`. Re-render the field from the `effective` value in the response rather than from what was typed — the validators normalise, so the two differ.

Add matching styles to `layout()`'s stylesheet for `.field`, `.badge`, `.default` and `.note`.

- [ ] **Step 4: Add the routes**

In `src/index.ts`, beside the existing `/api/status` handler:

```ts
      if (path === '/settings') {
        if (!viewer) return json({ error: 'not authorised' }, 403);
        const overrides = await readOverrides(env.DB);
        // 0 until Task 9 adds countRescorable.
        return html(renderSettings(defaultCriteria, overrides, 0));
      }

      if (path === '/api/settings' && request.method === 'POST') {
        if (!viewer) return json({ error: 'not authorised' }, 403);
        const body = (await request.json()) as { key?: string; value?: unknown; reset?: boolean };
        const key = String(body.key ?? '');
        if (!isSettableKey(key)) return json({ error: 'unknown setting' }, 400);

        if (body.reset) {
          await clearOverride(env.DB, key);
          return json({ ok: true, key, effective: (await loadCriteria(env.DB))[key as keyof Criteria] });
        }

        const result = FIELD_VALIDATORS[key](body.value);
        if (!result.ok) return json({ error: `${key} ${result.error}` }, 400);
        await setOverride(env.DB, key, result.value);
        return json({ ok: true, key, effective: result.value });
      }
```

Returning `effective` lets the page render what actually took effect rather than what was typed — the validators normalise, so the two differ.

- [ ] **Step 5: Link it from the portal**

Add a `/settings` link to the portal header in `src/web/portal.ts`, beside the existing navigation.

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run typecheck`
Expected: all PASS, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add src/web/settings.ts src/web/portal.ts src/index.ts test/settings-page.test.ts
git commit -m "Add the settings page and its save endpoint"
```

---

### Task 9: Rescore

A job is scored exactly once — `getUnscoredJobs` skips anything with a `scores` row — so no settings change reaches a score already stored.

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/index.ts` (one route)
- Modify: `src/web/settings.ts`
- Test: `test/db-rescore.test.ts`

**Interfaces:**
- Consumes: `loadCriteria` (Task 4).
- Produces:
  - `countRescorable(db: D1Database, sinceIso: string): Promise<number>`
  - `clearScoresSince(db: D1Database, sinceIso: string): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `test/db-rescore.test.ts`. Follow the SQL-assertion style already used for `getUnscoredJobs` in the existing db tests: assert the statement text and the bind order.

```ts
import { describe, expect, it, vi } from 'vitest';
import { clearScoresSince, countRescorable } from '../src/lib/db';

function fakeDb(returns: unknown) {
  const bind = vi.fn().mockReturnThis();
  const stmt = { bind, first: vi.fn().mockResolvedValue(returns), run: vi.fn().mockResolvedValue({ meta: { changes: 3 } }) };
  const prepare = vi.fn().mockReturnValue(stmt);
  return { db: { prepare } as unknown as D1Database, prepare, bind };
}

describe('rescore helpers', () => {
  it('counts only scores inside the window', async () => {
    const { db, prepare, bind } = fakeDb({ n: 47 });
    await countRescorable(db, '2026-08-11T00:00:00.000Z');
    expect(prepare.mock.calls[0][0]).toContain('FROM scores');
    expect(prepare.mock.calls[0][0]).toContain('first_seen_at >=');
    expect(bind).toHaveBeenCalledWith('2026-08-11T00:00:00.000Z');
  });

  it('deletes only scores inside the window and reports the count', async () => {
    const { db, prepare, bind } = fakeDb(null);
    const deleted = await clearScoresSince(db, '2026-08-11T00:00:00.000Z');
    expect(prepare.mock.calls[0][0]).toContain('DELETE FROM scores');
    expect(bind).toHaveBeenCalledWith('2026-08-11T00:00:00.000Z');
    expect(deleted).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/db-rescore.test.ts`
Expected: FAIL — `countRescorable` is not exported from `../src/lib/db`.

- [ ] **Step 3: Implement the helpers**

In `src/lib/db.ts`:

```ts
/**
 * Scores for jobs still inside the lookback window. Bounded by the job's
 * first_seen_at rather than the score's scored_at, because the question is
 * "which jobs would the next run reconsider", and getUnscoredJobs bounds on
 * first_seen_at too.
 */
export async function countRescorable(db: D1Database, sinceIso: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM scores s
       JOIN jobs j ON j.id = s.job_id
       WHERE j.first_seen_at >= ?`,
    )
    .bind(sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function clearScoresSince(db: D1Database, sinceIso: string): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM scores WHERE job_id IN (
         SELECT j.id FROM jobs j WHERE j.first_seen_at >= ?
       )`,
    )
    .bind(sinceIso)
    .run();
  return result.meta?.changes ?? 0;
}
```

- [ ] **Step 4: Add the route**

In `src/index.ts`:

```ts
      if (path === '/api/rescore' && request.method === 'POST') {
        if (!viewer) return json({ error: 'not authorised' }, 403);
        const criteria = await loadCriteria(env.DB);
        const since = db.daysAgoIso(criteria.lookbackDays + 3);
        const cleared = await db.clearScoresSince(env.DB, since);
        console.log(`rescore: cleared ${cleared} scores since ${since}`);
        return json({ ok: true, cleared });
      }
```

- [ ] **Step 5: Feed the real count to the page**

`renderSettings` already takes `rescorable` and renders the panel — Task 8 built it and passes `0`. Replace that placeholder in the `/settings` route:

```ts
        const criteria = await loadCriteria(env.DB);
        const rescorable = await db.countRescorable(env.DB, db.daysAgoIso(criteria.lookbackDays + 3));
        return html(renderSettings(defaultCriteria, overrides, rescorable));
```

The window matches the one `/api/rescore` deletes and the one `getUnscoredJobs` reads, so the number shown is exactly the number affected.

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run typecheck`
Expected: all PASS, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db.ts src/index.ts src/web/settings.ts test/db-rescore.test.ts test/settings-page.test.ts
git commit -m "Add a manual rescore that clears scores inside the lookback window"
```

---

### Task 10: Deploy and verify against the live database

**Files:**
- Modify: `src/index.ts` (`BUILD`)

- [ ] **Step 1: Bump the build marker**

In `src/index.ts`, change `export const BUILD = 'v11-lead-title-gate';` to `'v12-runtime-settings'`.

- [ ] **Step 2: Typecheck, test, deploy**

```bash
npm run typecheck && npm test && npm run deploy
```

- [ ] **Step 3: Confirm the deploy is actually serving**

Open `https://jobs.foundry-ns.com/health` in a browser — it is behind Access, so `curl` will not work — and confirm `build` reads `v12-runtime-settings`. Deploys are not instant; do not test until this shows the new marker.

- [ ] **Step 4: Exercise the settings page**

In the browser: open `/settings`, change `minScoreForDigest` to 45, confirm it shows as overridden, then Reset it and confirm the badge clears. Verify with:

```bash
npx wrangler d1 execute job-monitor --remote --command "SELECT * FROM settings"
```

Expected: a row appears after the save and is gone after the reset.

- [ ] **Step 5: Run the pipeline and read the funnel**

Trigger `/run` from the browser, then:

```bash
npx wrangler d1 execute job-monitor --remote --command \
  "SELECT started_at, fetched, new_jobs, prefiltered, scored, digested FROM runs ORDER BY id DESC LIMIT 1"
```

Expected: `prefiltered` in the tens rather than 1 — the 18 August measurement predicted 35 survivors from the widened title gate against the backlog. If it is still 1, the widened `titleAllow` did not reach production; check the build marker before changing anything.

- [ ] **Step 6: Confirm attendance is being extracted**

```bash
npx wrangler d1 execute job-monitor --remote --command \
  "SELECT attendance, COUNT(*) n, MIN(score) lo, MAX(score) hi FROM scores WHERE attendance IS NOT NULL GROUP BY attendance"
```

Expected: a spread across the values, not everything in one bucket. Everything landing in `unstated` means the extraction rule is not working on truncated excerpts and rule 4 needs tightening.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "Bump build marker for runtime settings"
git push
```

---

## Notes for whoever executes this

**Not in scope, deliberately.** The Adzuna collector has returned HTTP 503 for all four seed queries on every run since 16 August and no Adzuna row has been stored since the 15th. It is real and it is a third of the supply, but it is a collector fix and it is not this plan. Do not fold it in.

**What this plan does not promise.** Widening the title gate reliably gets roughly 35 more postings to the scorer per run. Whether any of them clear 40 depends on what is actually being advertised. This work unblocks the funnel; it does not manufacture remote jobs. An empty digest after Task 10 is a supply finding, not a bug — check `prefiltered` and the score spread before concluding anything is broken.
