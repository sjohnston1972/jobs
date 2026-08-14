# Gmail as a job source — design

**Date:** 2026-08-14
**Status:** approved, not yet planned

## Why

Reed and Adzuna are the only collectors. Indeed and LinkedIn carry a large share
of UK remote architecture roles and neither offers a usable public API, so their
alert emails are the only practical route into the pipeline. The inbox already
receives them daily — on 13 August 2026, eight Indeed alerts and six LinkedIn
alerts — and they carry fully remote roles the boards this monitor polls did not
surface, such as a "Senior Azure Logic Apps Developer — Contract role, UK, fully
remote". Whether such roles would clear the scoring threshold is untested; what
is established is that they reach the inbox and never reach the pipeline.

## Scope

In: Indeed job alert digests (`donotreply@jobalert.indeed.com`); LinkedIn job
alerts (`jobalerts-noreply@linkedin.com`, `jobs-noreply@linkedin.com`).

Out, with reasons:

- **Indeed match emails** (`donotreply@match.indeed.com`). Sponsored placements,
  not matches — the footer states Indeed "may be compensated by these employers"
  and ranks "based on a combination of employer bids and relevance". Their links
  are `pagead/clk` ad redirects carrying no `jk` job key, so there is no stable
  id and no canonical URL to rebuild, and they carry no posting date. The two
  postings sampled were a Bermuda relocation and a self-employed field sales
  role.

- **Google job alerts** (`notify-noreply@google.com`). The plain-text part
  carries no URL for any posting — links exist only in the HTML, wrapped in
  `google.com/url` redirects — so there is no stable id and nothing to click
  through to. Every entry sampled was sourced `via LinkedIn`, making it a
  strictly worse view of data this design already ingests directly. Re-addable
  later by parsing the HTML part, if the LinkedIn alerts ever stop covering it.
- **CV-Library.** The account was created on 2026-08-14 and no alert emails have
  arrived yet. Its sender is a one-line addition to `gmailQuery` plus a parser
  once the format is known.
- **Recruiter mail from humans.** Free-form prose with no reliable structure.
  A different problem, needing a model rather than a parser.

## Constraints that shape the design

**Alert emails carry excerpts, not adverts.** There is no detail endpoint to
enrich from, and the links are personalised tracking redirects that LinkedIn and
Indeed will usually meet with a login wall or bot check when fetched from a
Worker. The excerpt is all we get.

**LinkedIn alerts carry no description at all** — title, employer, location and
a job id, nothing more. Scorer rule 2 makes `remote_confidence` `low` when
nothing in the text addresses working location, and `score.ts:209` caps a low
posting at 39. `minScoreForDigest` is 60. A LinkedIn-email posting therefore
cannot reach the digest by arithmetic, not by tuning. Scoring one only spends.

**Email walks around the cheap-ACL design.** `bodyGate` passes anything marked
`description_truncated` to the scorer rather than judging it, which is correct
for board excerpts but means every email posting would reach Claude. One day's
Indeed traffic alone exceeds `maxScoredPerRun`.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport | Gmail API, read-only, pull | Matches the existing pull-shaped pipeline; re-runnable via `/run`; can backfill for parser testing. Email Routing would invert the pipeline to push and add a staging table, a MIME parser and a second entry point. |
| Gating | Strict title gate + hard per-run cap | Keeps two-tier economics without a second model call. `titleAllow`/`titleBlock` already discard the service-desk and AV noise that dominates Indeed alerts. |
| LinkedIn | Ingest as leads, never score | Collected and browsable in the portal; excluded from scoring because it cannot clear the threshold. |
| Google alerts | Dropped | No URL, no id, duplicates LinkedIn. |

## Architecture

`fetchGmail()` joins `fetchReed()` and `fetchAdzuna()` in stage 1 of
`runPipeline` and returns `NormalisedJob[]`. Dedupe, gates, scoring, digest and
portal are unchanged except where stated under "Changes outside the new module".

```
src/sources/gmail/
  client.ts     OAuth refresh -> access token; list and get messages; decode parts
  indeed.ts     pure: (plainTextBody, receivedAt) -> RawPosting[]
  linkedin.ts   pure: (plainTextBody, receivedAt) -> RawPosting[]
  index.ts      fetchGmail(): dispatch by sender, normalise, withHash
```

The parsers are pure functions from a string to objects. They are the fragile
part of this feature — they depend on a third party's email template — so they
take no network, no token and no environment, and can be pinned against saved
fixtures.

### client.ts

- `getAccessToken(env)` — one POST to `https://oauth2.googleapis.com/token` with
  `grant_type=refresh_token`, once per run. Access tokens last an hour and a run
  takes seconds, so no caching layer is warranted.
- `listMessages(token, query, max)` — `users/me/messages`.
- `getMessage(token, id)` — `users/me/messages/{id}?format=full`.
- `plainTextPart(payload)` — walks `payload.parts` recursively for the first
  `text/plain` part and base64url-decodes `body.data`. Gmail returns part bodies
  already decoded from their transfer encoding, so no quoted-printable handling
  is expected here — but see Risks.

Scope requested is `https://www.googleapis.com/auth/gmail.readonly` and nothing
else. The Worker never writes to, labels, or deletes mail.

### Auth setup (one time, by hand)

1. Google Cloud project, Gmail API enabled, OAuth 2.0 Desktop client.
2. `scripts/gmail-auth.mjs` — a local throwaway Node script that prints the
   consent URL, takes the pasted code, exchanges it, and prints the refresh
   token. Not deployed, not imported by the Worker.
3. `wrangler secret put` for `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
   `GMAIL_REFRESH_TOKEN`. Local copies into the gitignored `.env`.
4. **Publish the OAuth app to "In production" in the console.** `gmail.readonly`
   is a restricted scope, and Google expires refresh tokens after 7 days while
   an app sits in "Testing". Left in Testing, this source dies silently every
   week. Accept the unverified-app warning on the one consent screen.

### Query

Default, requiring no Gmail-side configuration:

```
newer_than:2d from:(donotreply@jobalert.indeed.com
  OR jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com)
```

Lives in `config/criteria.json` as `gmailQuery`, bundled at build time like the
rest of the tuning — adding a sender is a config edit and a redeploy, the same
lever as widening `titleAllow`. Swapping it for `label:job-alerts newer_than:2d`
moves curation into a Gmail filter without a code change.

The two-day window deliberately overlaps a one-day cron. Re-fetched messages
produce the same `source_id` and are absorbed by the existing `id` dedupe.

`maxEmailsPerRun` (default 40) bounds the message fetches.

### Parsing: Indeed

Body runs from the header to the line `Do not share this email`. Blocks are
separated by blank lines. Lines within a block are classified by pattern, not by
position — badges such as `Easily apply`, `Responsive employer` and
`Urgently hiring` appear inconsistently, so counting lines breaks on the first
posting that omits one.

| Field | Source |
|---|---|
| `source_id` | `jk` parameter from the posting URL |
| `url` | rebuilt canonical `https://uk.indeed.com/viewjob?jk=<key>` |
| `title` | first line of the block |
| `employer`, `location_raw` | `Employer - Location`, split on the last ` - ` |
| `salary_min`, `salary_max`, `salary_period` | `£63,000 - £67,000 a year` |
| `salary_predicted` | always `1` |
| `posted_at` | email `Date` minus the relative age line |
| `description` | `Location: <location>\n<snippet>` |
| `description_truncated` | always `1` |
| `remote_flag` | `looksRemote(title, location + snippet)` |
| `contract_type` | `inferContractType(title + snippet)` |

The canonical URL replaces the personalised tracking link, which the email
itself asks not to be shared and which may expire.

**Postings whose URL carries no `jk` are skipped and counted.** Indeed seeds
sponsored slots into organic digests as `pagead/clk` ad redirects. They have no
job key, so no stable id, and their ad tokens change on every send, meaning any
synthesised id would defeat dedupe rather than serve it.

Measured on 2026-08-14 across three digests: **24 of 38 links were sponsored,
against 14 organic.** Roughly two thirds of what an Indeed digest appears to
offer is advertising, so this skip is the majority path rather than an edge case,
and expected yield is about a third of the raw link count. The skip count is
logged per run so a further rise is visible rather than silent.

Salary periods map onto the existing `annual | daily | unknown` so no migration
is needed: `a year` → annual, `a month` × 12 → annual, `a day` → daily,
`an hour` × 7.5 → daily.

`salary_predicted = 1` unconditionally. Indeed's footer states it estimates
salaries where the employer gives none and the email does not mark which are
which, so flagging all of them is the only honest reading. The portal already
surfaces the flag.

The `Location: ` prefix on the description is load-bearing. Indeed frequently
writes `Remote` or `Hybrid remote in London` in that slot, and it is the only
text in the email that legitimately addresses working location for the scorer to
quote in `remote_evidence`.

Relative ages seen: `Just posted`, `Today`, `N days ago`, `Active N days ago`.
Anything unrecognised falls back to the email's `Date`.

### Parsing: LinkedIn

Blocks are separated by a rule of hyphens. Each block is title, employer,
location, optional badges (`1 company alum`, `This company is actively hiring`,
`Apply with resume & profile`), then `View job: <url>`.

`source_id` is the digits from `/jobs/view/(\d+)`; `url` is the canonical
`https://www.linkedin.com/jobs/view/<id>/`. `description` is `Location: <location>`
and nothing else. No salary is present, so `role_hash` will be null — correct,
since title alone is too weak a key.

### Not scoring LinkedIn

Applied in `runPipeline` immediately after the title gate:

```ts
/** Sources whose alert emails carry no description. A posting with no text
 *  about working location scores "low" confidence by rule 2, which score.ts
 *  caps at 39 — below minScoreForDigest. Scoring them cannot ever surface
 *  one; it only spends. They are collected as leads for the portal. */
const UNSCORED_SOURCES = new Set(['linkedin']);
```

A named constant carrying its own reasoning, rather than a condition buried in a
filter — so whoever next widens the source list sees why the exception exists
instead of deleting it as dead weight.

### Budget

`maxEmailJobsPerRun` (default 15) caps email-sourced postings *before* the
global `maxScoredPerRun` of 40 is applied. Without a separate cap, one noisy
Indeed morning consumes the entire scoring budget and crowds out Reed and
Adzuna. Order is: title gate, then email cap, then global cap.

## Changes outside the new module

- `NormalisedJob['source']` widens to `'reed' | 'adzuna' | 'indeed' | 'linkedin'`.
- `Env` gains the three Gmail secrets.
- `Criteria` gains `gmailQuery`, `maxEmailsPerRun`, `maxEmailJobsPerRun`;
  `config/criteria.json` gains their values.
- The Gmail fetch is wrapped in its own `try`/`catch` in stage 1 alongside Reed
  and Adzuna. One dead API must never suppress the digest.
- Portal source filter gains `indeed` and `linkedin`.
- `BUILD` bumped.
- **No database migration.** `jobs.source` is an unconstrained `TEXT` column.

### New endpoint

`/gmail/preview?days=N` behind Access, mirroring `/digest/preview`: runs the
parsers over the last N days and renders what they extracted **without
inserting**. This is the tool for the morning after Indeed changes its template.

## Testing

Add `vitest` and pin both parsers against fixtures captured from real emails,
stored under `test/fixtures/`.

This is a deliberate departure from a repo that currently has no tests. The
parsers depend on a third party's email template that will change without
notice, and the failure mode is silent: zero postings parsed, no exception, no
error in the run record, and a digest that simply gets quieter. A fixture test
converts that into a failing build. Fixtures are scrubbed of tracking tokens and
the personalised links the emails ask not to be shared.

Coverage: one multi-posting Indeed digest including a sponsored `pagead` slot
that must be skipped, one LinkedIn digest, a posting missing each optional line
(no salary, no badge, no snippet), and an email with no postings at all.

## Risks

**Indeed `jk` decoding.** In the copies read during design, `jk` values arrived
mangled (`jk~4b22c7f0b7ba6a`, `jk987da…`) — quoted-printable artifacts of
the tool used to read them, where `=` is the escape character. The Gmail API
returns part bodies already decoded, and a live fetch on 2026-08-14 confirmed it:
all 14 organic links sampled came back as clean 16-character hex keys, and the
artifact is explained exactly — `jk=5a8e...` renders as `jkZ8e...` because
quoted-printable decodes `=5A` to `Z`. **Resolved. `jk` is safe as `source_id`.**

**Subrequest ceiling.** This adds 1 token exchange plus up to 41 Gmail calls to
a run that already issues up to 8 board searches, 60 Reed enrichments, 40
scoring calls and one Resend. The run is already well past the 50-subrequest
free-tier limit, so the account is on a paid plan with a 1000 limit; the new
total stays comfortably inside it. Worth confirming rather than assuming.

**Template drift.** Mitigated by the fixture tests and `/gmail/preview`, not
eliminated. When Indeed changes its layout the source goes quiet, and the
counters logged per parser (messages fetched, postings parsed, per sender) are
what make that visible in `wrangler tail`.

**Token revocation.** Changing the Google account password or revoking app
access in Google's security settings invalidates the refresh token. The failure
surfaces as an error string on the run record and in the digest, since the fetch
is wrapped like any other source.

## Out of scope for this build

- Fetching canonical job pages to enrich thin excerpts. LinkedIn and Indeed
  block Workers often enough that it needs its own spike first.
- A cheap batched pre-score triage pass. Considered and rejected in favour of
  the title gate plus cap; revisit if the cap proves too blunt.
- Parsing recruiter mail written by humans.
- Indeed match emails, Google alerts and CV-Library, per Scope.
