# Job Monitor: Build Specification

Version 1.0
Owner: Steven
Platform: Cloudflare Workers

---

## 1. Purpose

A scheduled service that polls UK job APIs once a day, filters for fully remote roles matching a defined profile, scores each new posting against a CV using the Claude API, and emails a digest of anything worth reading. Applications are tracked from links inside the digest.

The mental model is a polling collector with a policy engine attached. The Worker is the collector, D1 is the state table, the keyword rules are a cheap ACL applied first, and the Claude call is the expensive deep inspection applied only to what survives the ACL.

## 2. Scope

**In scope for v1**

- Daily poll of Reed and Adzuna
- Deduplication so a posting is only ever presented once
- Keyword prefilter before any AI spend
- AI scoring against a stored CV, returning a score and a reason
- Daily digest email
- Application status tracking via signed links in the digest
- On-demand tailored CV and cover letter for a chosen posting

**Out of scope for v1**

- Any scraping of LinkedIn, Indeed, or any site whose terms forbid it. All data comes from documented APIs
- Automatic application submission
- A web dashboard. Email plus D1 queries is sufficient until the pipeline is proven
- Contracts Finder and Find a Tender integration. Designed for later, see section 12

## 3. Architecture

```
Cloudflare Cron Trigger (daily 06:00 UTC)
        |
        v
   Worker: scheduled()
        |
        +--> fetch()   Reed API, Adzuna API
        +--> normalise()  map both into one job shape
        +--> dedupe()     skip anything already in D1
        +--> prefilter()  keyword allow/block, cheap and local
        +--> score()      Claude API, one call per surviving job
        +--> digest()     build markdown and HTML
        +--> send()       Resend to inbox
        |
        v
   D1 database (jobs, scores, applications, runs)

Worker: fetch() handler serves
   GET /track    signed status update links from the digest
   GET /tailor   on-demand CV and cover letter draft
   GET /health   last run summary
```

**Plain English on the Cloudflare pieces**

- **Worker**: the application itself. A single JavaScript or TypeScript file that Cloudflare runs on demand. There is no server to patch
- **Cron Trigger**: the scheduler. Equivalent to a cron entry on a jump box, except it lives in the Worker config. Cron expressions run in UTC, so a 06:00 UTC trigger arrives at 07:00 during British Summer Time and 06:00 in winter. Accept the shift rather than fighting it
- **D1**: Cloudflare's managed SQLite. A real relational database accessed over a binding rather than a connection string. This is where state lives, so the job survives restarts and redeploys
- **Bindings**: how a Worker gets access to D1 or a secret. Declared in config, injected as `env.DB` or `env.REED_API_KEY` at runtime. Nothing is imported from disk

## 4. Configuration and secrets

**Secrets** (never committed)

| Name | Purpose |
|---|---|
| `REED_API_KEY` | Reed jobseeker API |
| `ADZUNA_APP_ID` | Adzuna app identifier |
| `ADZUNA_APP_KEY` | Adzuna key |
| `ANTHROPIC_API_KEY` | Scoring and tailoring |
| `RESEND_API_KEY` | Digest delivery |
| `TRACK_SIGNING_SECRET` | HMAC key for the tracking links |
| `DIGEST_TO` | Destination address |
| `DIGEST_FROM` | Sending address on foundry-ns.com |

For local development Wrangler reads secrets from either a `.dev.vars` file or a `.env` file in the same directory as the Wrangler config. <cite index="26-1">Choose one or the other, not both, because if a `.dev.vars` file exists the `.env` values are ignored during local development.</cite> Either file must be in `.gitignore`.

For the deployed Worker, local files are irrelevant. Push each secret once with `wrangler secret put NAME`, or set them in the dashboard. <cite index="23-1">Secret values are not visible in Wrangler or the dashboard after being defined.</cite>

Optionally declare the required names in the Wrangler config using the `secrets` property, which <cite index="24-1">validates them during local development and deploy and fails the deploy if any are missing.</cite> Worth doing, since a missing key at 06:00 should fail loudly at deploy time instead.

**Non-secret config** lives in two files in the repo, both plain text so they can be edited without touching code:

- `config/profile.md` : the CV in markdown. Read at build time or stored in D1, passed into every scoring call
- `config/criteria.json` : keywords, thresholds, and rules

```json
{
  "titleAllow": ["network architect", "cloud network", "solutions architect",
                 "infrastructure architect", "network consultant",
                 "principal engineer", "technical lead"],
  "titleBlock": ["sales", "account manager", "graduate", "apprentice",
                 "field engineer", "desktop support", "1st line", "2nd line"],
  "bodyRequireAny": ["remote", "home based", "homeworking", "fully remote"],
  "minScoreForDigest": 60,
  "maxScoredPerRun": 40,
  "lookbackDays": 7,
  "contractTypes": ["permanent", "contract"]
}
```

## 5. Data sources

### 5.1 Reed jobseeker API

- Base: `https://www.reed.co.uk/api/1.0/search`
- Auth: HTTP Basic, API key as the username with an empty password. In a Worker that is an `Authorization: Basic ` header containing base64 of `KEY:`
- Returns full job descriptions, which matters because the scorer needs the body text to judge whether "remote" is genuine
- Key params: `keywords`, `locationName`, `postedByRecruitmentAgency`, `fullTime`, `permanent`, `contract`, `resultsToTake`, `resultsToSkip`
- Pagination: `resultsToSkip` in steps of `resultsToTake`

### 5.2 Adzuna API

- Base: `https://api.adzuna.com/v1/api/jobs/gb/search/{page}`
- Auth: `app_id` and `app_key` as query parameters
- Key params: `what`, `where`, `max_days_old`, `results_per_page`, `contract_type`
- Two known limitations to handle in code: descriptions are truncated, so treat Adzuna body text as an excerpt and weight the scorer accordingly, and salary may be estimated rather than stated. Adzuna returns a `salary_is_predicted` flag. Store it and never present a predicted figure as the employer's number
- Free tier quota is limited (published figures vary, roughly 1,000 calls a month with per-day and per-minute ceilings). Confirm current limits on the developer portal before setting the query count. Budget conservatively: at 4 keyword queries per day, a month costs about 120 calls

### 5.3 Query strategy

Run a small fixed set of searches per source per day rather than one broad one. Broad queries return noise and burn quota. Suggested seed set, tuned after the first week:

```
"network architect"
"cloud network engineer"
"solutions architect network"
"infrastructure architect remote"
```

Each search requests the last `lookbackDays` days. The lookback overlaps deliberately: dedupe handles the repeats, and the overlap covers a missed run.

## 6. Data model (D1)

```sql
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,      -- "reed:40227781" or "adzuna:123456"
  source          TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  employer        TEXT,
  location_raw    TEXT,
  remote_flag     INTEGER,               -- what the source claims, not trusted
  contract_type   TEXT,                  -- permanent | contract | unknown
  salary_min      REAL,
  salary_max      REAL,
  salary_predicted INTEGER DEFAULT 0,
  currency        TEXT,
  url             TEXT NOT NULL,
  description     TEXT,
  description_truncated INTEGER DEFAULT 0,
  posted_at       TEXT,
  first_seen_at   TEXT NOT NULL,
  content_hash    TEXT NOT NULL          -- normalised title + employer + salary
);
CREATE INDEX idx_jobs_hash ON jobs(content_hash);
CREATE INDEX idx_jobs_seen ON jobs(first_seen_at);

CREATE TABLE scores (
  job_id            TEXT PRIMARY KEY REFERENCES jobs(id),
  score             INTEGER NOT NULL,    -- 0 to 100
  remote_confidence TEXT,                -- high | medium | low
  remote_evidence   TEXT,                -- the phrase the model relied on
  ir35_signal       TEXT,                -- inside | outside | unstated | n/a
  reason            TEXT,                -- one line
  red_flags         TEXT,                -- JSON array
  model             TEXT,
  scored_at         TEXT NOT NULL
);

CREATE TABLE applications (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(id),
  status      TEXT NOT NULL,             -- interested | applied | rejected | interviewing | closed
  applied_at  TEXT,
  notes       TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  fetched      INTEGER DEFAULT 0,
  new_jobs     INTEGER DEFAULT 0,
  prefiltered  INTEGER DEFAULT 0,
  scored       INTEGER DEFAULT 0,
  digested     INTEGER DEFAULT 0,
  errors       TEXT
);
```

Two levels of deduplication, for the same reason a switch keeps both a MAC table and an ARP cache:

1. **Exact**: the `id` primary key stops the same posting from the same source reappearing
2. **Cross source**: `content_hash` catches the same role listed on both boards under different IDs. Normalise by lowercasing, stripping punctuation, collapsing whitespace, and removing common recruiter suffixes before hashing

## 7. Pipeline

### Stage 1: fetch

For each source, for each seed query, request the configured lookback window. Wrap every outbound call in a try/catch. A failing source records an error in `runs.errors` and the run continues with whatever the other source returned. One dead API must never suppress the digest.

### Stage 2: normalise

Map both source shapes into the `jobs` schema. Adzuna rows set `description_truncated = 1`. Contract type is inferred from source fields where present, otherwise `unknown`.

### Stage 3: dedupe

Skip any `id` already present. Skip any `content_hash` seen within the last 30 days. Insert the survivors with `first_seen_at = now`.

### Stage 4: prefilter

Local, no network, no cost. Reject if:

- Title matches nothing in `titleAllow`
- Title matches anything in `titleBlock`
- Body contains none of `bodyRequireAny`

This is the ACL. It exists so that AI spend only ever lands on plausible candidates. Log counts at this stage: if the prefilter is discarding everything, the seed queries are wrong, not the scorer.

### Stage 5: score

One Claude call per surviving job, capped at `maxScoredPerRun`. If more survive than the cap, take the most recently posted and leave the rest for the next run.

Model: `claude-haiku-4-5-20251001`. Scoring is high volume and structurally simple, so the cheapest capable model is correct here. Use `claude-sonnet-5` only if the reasons come back consistently shallow.

The prompt must return JSON and nothing else. Contract:

```json
{
  "score": 0,
  "remote_confidence": "high|medium|low",
  "remote_evidence": "the exact phrase in the posting that decided this",
  "ir35_signal": "inside|outside|unstated|n/a",
  "seniority_fit": "below|match|above",
  "reason": "one sentence, under 25 words",
  "red_flags": []
}
```

Prompt requirements:

- Supply `config/profile.md` as the candidate profile
- Instruct the model that the source's remote flag is unreliable and that `remote_confidence` must be based on wording in the description. A posting saying "remote with 2 days per week in the office" is `low` and scores below 40 regardless of how good the role is
- For contract postings, extract any IR35 statement. Inside IR35 is a red flag given the intention to trade through a limited company
- Instruct it to score conservatively and to prefer a low score over a generous one. An inbox of false positives is worse than an empty digest

Parse defensively: strip any markdown fences, `JSON.parse` inside a try/catch, and on failure store `score = -1` with the raw text in `reason` so the failure is visible rather than silent.

### Stage 6: digest and send

Query everything scored today at or above `minScoreForDigest`, ordered by score descending. Build both a plain markdown body and a simple HTML version. Send via Resend from the foundry-ns.com sending domain already configured.

If there are zero matches, still send a one line email confirming the run completed with counts. Silence is ambiguous: it could mean no matches or a broken cron.

## 8. Digest format

```
Job Monitor: 8 August 2026
Fetched 84, new 19, passed filter 6, scored 6, matched 2

--- 78 | Principal Network Architect | Acme Cloud Ltd
Permanent | £95k to £110k (stated) | Remote confidence: high
"fully remote, UK based, occasional travel for quarterly planning"
Strong overlap on Azure and Palo Alto, seniority matches.
View: https://...
Mark: [interested] [applied] [not interested]

--- 64 | Network Consultant (Outside IR35) | Beta Digital
Contract | £550/day | Remote confidence: medium | IR35: outside
Day rate stated, remote wording is softer than it first appears.
View: https://...
Mark: [interested] [applied] [not interested]

Filtered out 4 today: 3 hybrid, 1 seniority below.
```

Every posting shows the evidence phrase behind the remote judgement. That one field is what makes the digest trustworthy over time, because it lets a wrong call be spotted and the rules corrected.

## 9. Application tracking

The three `Mark:` links are signed URLs handled by the Worker's `fetch()` handler:

```
GET /track?job={id}&status={status}&sig={hmac}
```

`sig` is an HMAC-SHA256 of `job|status` using `TRACK_SIGNING_SECRET`, computed with the Web Crypto API. The handler verifies the signature, upserts into `applications`, and returns a plain confirmation page. Without the signature the endpoint is an open write to the database for anyone who guesses the URL.

A weekly summary email on Sunday lists everything currently at `applied` or `interviewing` with the age in days, so nothing goes stale unnoticed.

## 10. CV and cover letter tailoring

Deliberately outside the cron path, because it is expensive and only wanted occasionally.

```
GET /tailor?job={id}&sig={hmac}
```

Takes the stored job description and `config/profile.md`, calls `claude-sonnet-5` or `claude-opus-5`, and emails back a tailored CV summary plus a cover letter draft. Both are drafts for editing, never for sending unread.

Add a fourth `[tailor]` link to any digest entry scoring 70 or above.

## 11. Platform constraints

- **Subrequest limits**: every outbound `fetch` from a Worker counts. The free plan allows 50 per invocation, the paid plan 1,000. A run doing 8 source queries plus 40 scoring calls plus 1 email is roughly 49, which is against the ceiling on free. The $5 Workers Paid plan is the right call, and it also raises CPU time limits
- **CPU time**: scoring calls are mostly waiting on the network rather than burning CPU, so this is unlikely to bite. If it does, split scoring into a Cloudflare Queue consumer
- **Concurrency**: run scoring calls with a small concurrency of 3, not all 40 at once. Hitting the Anthropic API with 40 parallel requests invites rate limiting
- **Cost**: 40 Haiku calls a day on short inputs is pennies per month. D1 and Cron Triggers sit inside the free tier at this volume. The Workers Paid plan is the only fixed cost

## 12. Build phases

Each phase ends in something observable. Do not proceed until the acceptance criterion is met.

**Phase 0: scaffold**
Worker project, Wrangler config, D1 database created and bound, schema applied, secrets loaded.
*Acceptance*: `/health` returns the D1 table list.

**Phase 1: collection, no AI**
Both collectors, normalisation, dedupe, storage. Triggered manually.
*Acceptance*: two consecutive manual runs, where the second inserts zero new rows.

**Phase 2: prefilter**
Keyword rules from `criteria.json`, with counts logged into `runs`.
*Acceptance*: a run reports fetched, new, and passed counts, and manual review of 10 passed rows says most are plausible.

**Phase 3: scoring**
Claude integration, JSON parsing, `scores` table populated.
*Acceptance*: 20 scored jobs where the reason lines are specific to each posting rather than generic, and the remote evidence field genuinely quotes the description.

**Phase 4: digest**
Markdown and HTML build, Resend delivery, cron trigger enabled.
*Acceptance*: a digest arrives at 06:00 UTC for three consecutive days, including on a day with no matches.

**Phase 5: tracking**
Signed links, `applications` table, weekly summary.
*Acceptance*: clicking a link from the email updates the row, and an unsigned URL is rejected.

**Phase 6: tailoring**
`/tailor` endpoint.
*Acceptance*: a tailored CV and cover letter arrive by email for a chosen posting.

**Phase 7 (later): public sector feed**
Contracts Finder and Find a Tender are open government APIs with a different shape: opportunities for a company to bid on rather than jobs to apply for. They warrant a separate table and a separate digest section, sharing only the scoring machinery.

## 13. Repository layout

```
job-monitor/
  wrangler.toml
  .env                    (gitignored, local only)
  .gitignore
  package.json
  schema.sql
  config/
    profile.md            the CV
    criteria.json         keywords and thresholds
  src/
    index.ts              scheduled() and fetch() entry points
    sources/
      reed.ts
      adzuna.ts
    pipeline/
      normalise.ts
      dedupe.ts
      prefilter.ts
      score.ts
      digest.ts
    lib/
      db.ts
      claude.ts
      email.ts
      sign.ts
  CLAUDE.md               standing context for Claude Code
```

`src/` splits by pipeline stage rather than by file size. Each stage takes one shape of data and returns another, so any single stage can be tested or replaced without touching the others. Swapping Reed for a different board should mean writing one file in `sources/` and nothing else.

## 14. Success criteria

The build is done when, after two weeks of running unattended:

- The digest arrives every day without manual intervention
- No posting has ever appeared twice
- Fewer than one in five digest entries is judged irrelevant on reading
- No hybrid role has been presented as fully remote more than once, and when it has, the evidence field showed why
- Application status reflects reality without any manual database editing

## 15. Open decisions

1. Digest time. 06:00 UTC assumed. A run at 05:00 UTC would deliver before 07:00 all year
2. Score threshold. 60 assumed, likely to need tuning after week one. Expect to move it up, not down
3. Whether to include roles from recruitment agencies. Reed exposes a flag. Including them raises volume and noise, excluding them loses genuine contract opportunities. Suggest including for the first two weeks and reviewing
4. Whether the salary floor should be a hard prefilter or a scoring input. Suggest scoring input, since many strong postings hide salary
