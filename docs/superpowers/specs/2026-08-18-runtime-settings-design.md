# Runtime-adjustable tuning — design

**Date:** 2026-08-18
**Status:** approved, not yet planned

## Why

The digest has never fired. Five scheduled runs between 14 and 18 August 2026
sent five "nothing matched" emails, and the investigation behind this design
found two independent causes, both of them tuning rather than code.

The first is a defect in `config/criteria.json`. `titleGate` does a plain
substring match, and `titleAllow` carries `"solutions architect"` — plural.
That does not match "Solution Architect", so "Senior Solution Architect",
"Oracle Cloud Solution Architect" and "Solution Architect - Infrastructure &
Networks" were all discarded. `"network consultant"` likewise misses
"Networking Consultant", and `network engineer` is absent from `titleAllow`
altogether even though `"cloud network engineer"` is one of the four seed
queries — the monitor pays Reed and Adzuna to search for network engineers and
throws every result away. Measured against the 221 unscored postings in the
lookback window on 18 August, the title gate admitted 8; adding the missing
variants admits 43.

The second is that `minScoreForDigest` sits at 60 and no posting has ever
scored above 42. Of 45 scores recorded, 42 carry `remote_confidence: low`. The
39-cap has never once fired — the model scores below it unaided, because the
roles genuinely are not remote. One posting reading "98% remote with very
occasional travel" scored 28 against a candidate the same model called a strong
technical and seniority fit.

Both causes are one-line edits to a JSON file. Neither could be made without a
`wrangler deploy`, and neither could be made from a phone. The tuning that
decides whether this tool produces anything at all is the part of it hardest to
reach, and the evidence above says it will need adjusting repeatedly before the
right settings are known.

## Scope

In: every field of `Criteria` becomes adjustable at runtime from a settings page
in the portal, including the keyword lists and the model names.

In: a new three-level remote requirement replacing the hard-coded fully-remote
rule.

In: a manual rescore action, because a job is scored exactly once and no
settings change reaches a score already stored.

Out, with reasons:

- **`config/profile.md`.** It is prose fed to the scorer, not tuning. A textarea
  editing the candidate profile is a different feature with different failure
  modes, and nothing in the empty-digest investigation points at it.
- **`contractTypes`.** Declared in the `Criteria` type and present in the JSON,
  but referenced nowhere in `src/`. It is dead config. A settings page that
  offered it would be advertising a control that does nothing, which is worse
  than not offering it. Either delete the field or implement it — a separate
  decision, and not one this design should make silently.
- **The Adzuna 503s.** All four seed queries have returned HTTP 503 on every run
  since 16 August and no Adzuna row has been stored since the 15th. Real, and
  unrelated — a fix in the collector, not in tuning.
- **Scheduling.** The cron expression stays in `wrangler.toml`.

## Constraints that shape the design

**`criteria` is a compile-time constant today.** `src/lib/config.ts` does
`import criteriaJson from '../../config/criteria.json'` and exports it. The
prefilter, scorer, digest builder and portal all read that one object. Making it
runtime-mutable changes how every stage receives its configuration, which is why
this is a design and not a patch.

**Editing the file and redeploying must keep working.** CLAUDE.md documents
`config/criteria.json` plus a deploy as the tuning workflow. If a database became
the whole source of truth, that documented process would silently stop having any
effect — the worst possible failure, because it looks like a deploy problem.

**A run must be internally consistent.** Stage 4 selects what to score and stage
6 selects what to digest, both from `minScoreForDigest`. A settings change
landing between them must not make the two disagree.

**A bad setting must not be able to stop the pipeline.** `maxScoredPerRun: 0`,
an empty `titleAllow`, or a malformed stored value would each produce a silent
empty digest indistinguishable from the failure this design exists to fix.

**The remote levels are not expressible in the current score schema.** The model
returns `remote_confidence` as high/medium/low, which collapses "occasional
travel to London" and "London (Hybrid)" into the same value. The middle level
cannot be implemented on top of that field.

## Design

### Storage and precedence

A new table holding one row per **overridden** field:

```sql
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,   -- a Criteria field name
  value      TEXT NOT NULL,      -- JSON-encoded scalar or array
  updated_at TEXT NOT NULL
);
```

Sparse by design. `config/criteria.json` remains the defaults; the table holds
only fields actually changed through the UI. The effective value of a field is
the file default, overridden by its row if one exists.

This is what preserves the documented workflow. A field never touched in the UI
still tracks the file, so editing `criteria.json` and redeploying continues to
move it. Each field's **Reset to default** control deletes its row rather than
writing the current default into it, so a field can always be handed back to the
file.

### The merge layer

`src/lib/config.ts` gains:

```ts
export async function loadCriteria(db: D1Database): Promise<Criteria>
```

It reads the table, validates each stored value, and merges over the file
defaults. The existing `criteria` export stays as the raw file defaults, which
`loadCriteria` uses as its base and the settings UI uses to show what "default"
means.

`runPipeline` calls it **once**, at the top, and passes that snapshot through all
six stages. Every current use of `criteria` is already inside `runPipeline`, so
this is a local change: a module-scope import becomes a function-scope constant.
The `fetch` handler loads it per request for `/digest/preview`, `/gmail/preview`
and the portal render; `src/web/portal.ts` already takes `criteria` as a
parameter and needs no change at all.

A stored value that fails validation is logged and the file default used in its
place. The run continues.

### The remote requirement

A new `Criteria` field:

```ts
remoteRequirement: 'strict' | 'mostly' | 'any'
```

and a new field on the score schema, stored in a new `scores.attendance` column:

```ts
attendance: 'none' | 'occasional' | 'fixed' | 'onsite' | 'unstated'
```

`attendance` is a factual extraction rather than a judgment — what the posting
says about being in an office — so the model is reliable at it in a way it is
not at "is this acceptable". That keeps the policy in code, which is where
CLAUDE.md deliberately put it after the model drifted during the original build:

| level | score capped at 39 when |
|---|---|
| `strict` | `attendance` is anything but `none` — today's behaviour |
| `mostly` | `attendance` is `fixed` or `onsite` |
| `any` | never; remoteness is scored, not capped |

`unstated` never caps at any level. A posting silent on working location is the
case the body gate already defers to the scorer, and capping it would reject
genuinely remote roles for the accident of where an excerpt ended.

### The prompt coupling

Two rules in `SYSTEM_PROMPT` are told to the model rather than compared in code,
and both become interpolated:

- Rule 1 hard-codes *"60 is the threshold for 'worth reading'; do not drift
  upward to be helpful"*. With `minScoreForDigest` at 40 the prompt would still
  say 60. It takes the effective threshold.
- Rule 3 is the whole fully-remote policy, including its list of phrases that
  must be treated as "low". Its wording is selected by `remoteRequirement`, and
  it gains the instruction to extract `attendance`.

`SCHEMA_HINT` and the structured-output schema in `src/pipeline/score.ts` both
gain the `attendance` field.

### Settings page

`/settings`, behind the existing Access check, using the `layout()` helper and
following the `/api/status` POST pattern at `src/index.ts:384`.

- Scalars get typed inputs: number boxes for the thresholds and caps, a dropdown
  for `remoteRequirement`, dropdowns for `scoringModel` and `tailoringModel`.
- `titleAllow`, `titleBlock`, `bodyRequireAny` and `seedQueries` get add/remove
  list editors.
- Every field shows its file default and whether it is currently overridden.

`POST /api/settings` takes one field at a time, validates, and writes or deletes
the row. Returning the merged effective value lets the page render what actually
took effect rather than what was typed.

### Rescore

A job is scored exactly once — `getUnscoredJobs` skips anything with a `scores`
row — and `getDigestJobs` only selects scores where `scored_at >= runStartedAt`.
So today's digest contains only jobs scored that morning, and no settings change
can reach a score already stored. The 45 existing scores would stay frozen under
the strict remote rule for ever.

A **Rescore** button on the settings page deletes `scores` rows for jobs still
inside the lookback window, so the next run re-judges them. It shows the affected
count and states that each is a Claude call before it is pressed. It is never
automatic: a slider drag must not be able to spend money.

### Validation

Each field gets a validator with clamps, applied both at save and at load:

- `minScoreForDigest`, `tailorThreshold`: integers 0–100.
- `maxScoredPerRun`, `maxEmailsPerRun`, `maxEmailJobsPerRun`: integers, minimum
  1 — zero silently disables the stage.
- `lookbackDays`: integer 1–30.
- `titleAllow`, `seedQueries`: non-empty arrays of non-empty strings. An empty
  `titleAllow` admits nothing and an empty `seedQueries` fetches nothing; both
  produce exactly the silent empty digest this work exists to remove.
- `titleBlock`, `bodyRequireAny`: arrays of non-empty strings, may be empty.
- `remoteRequirement` and the model names: membership tests.

The page refuses a save that would stop the run and says why, rather than
accepting it and going quiet.

## Seeded state

The tuning decisions that prompted this work land as file defaults, not as
overrides, so they are visible in git and reversible by deploy:

- `titleAllow` gains `solution architect`, `network engineer`,
  `networking consultant`, `cloud architect`, `platform architect`,
  `network security`. Measured yield on the 18 August backlog: title survivors
  8 → 43, body survivors 0 → 35.
- `minScoreForDigest`: 60 → 40.
- `remoteRequirement`: `mostly`, new field.

`mostly` rather than `any` reads the stated intent — the complaint was a
98%-remote role scoring 28, not a wish to see London hybrids. It is one dropdown
change if that reading is wrong.

## Migration

One numbered file in `migrations/`: the `settings` table and the
`scores.attendance` column. `schema.sql` updated to match, as the current full
shape for a fresh database.

`BUILD` in `src/index.ts` bumped, per the deploy-verification note in CLAUDE.md.

## Testing

Unit tests, following the existing vitest layout in `test/`:

- **Merge and precedence.** File default with no row; override with a row;
  reset deleting a row; an invalid stored value falling back to the default
  rather than throwing.
- **Validation.** Each clamp, and specifically that an empty `titleAllow`, an
  empty `seedQueries` and a zero `maxScoredPerRun` are all refused.
- **The cap.** Every `remoteRequirement` × `attendance` pair against the table
  above, including `unstated` never capping.
- **Prompt interpolation.** The threshold reaching rule 1, and each level
  selecting its rule 3 wording.
- **Title gate.** A regression test on the singular/plural miss —
  "Senior Solution Architect" must pass with the widened list.

The run-consistency property (one snapshot per run) is a structural guarantee
from loading once in `runPipeline` rather than something a unit test can
observe, and is left to review.

## Consequences worth recording

- **Two places now define tuning.** A field's effective value is no longer
  readable from the repository alone; `/settings` has to be consulted to know
  what actually ran. The sparse table keeps this as small as possible, and the
  page marks overridden fields, but the ambiguity is real and is the price of
  the feature.
- **Widening the title gate feeds the scorer, not the digest.** 35 more postings
  reach Claude each run, all of them `description_truncated`. Whether any clear
  40 depends on supply, and this design does not promise that they will.
- **`attendance` is only populated going forward.** Existing score rows will
  hold NULL for it until rescored.
- **`tailorThreshold` is now above the observed ceiling.** It sits at 70 while
  the highest score ever awarded is 42, so the tailor link has never appeared
  and will not appear merely because the digest threshold drops to 40. It is
  adjustable on the settings page like everything else, but it is worth saying
  plainly that lowering `minScoreForDigest` alone leaves `/tailor` unreachable.
  The page should show the two thresholds together so the relationship between
  them is visible.
