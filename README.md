# Job Monitor

A scheduled service that polls UK job APIs once a day, filters for fully remote
roles matching a defined profile, scores each new posting against a CV using the
Claude API, and emails a digest of anything worth reading. Applications are
tracked from links inside the digest, and everything collected is browsable in a
private portal.

Runs on Cloudflare Workers with D1 for state. Full design: `job-monitor-spec.md`.

## What it does each morning

1. **Fetch** — four seed queries against Reed and Adzuna, last 7 days.
2. **Dedupe** — three levels: source id, content hash, and a role hash that
   collapses the same job advertised by several agencies.
3. **Title gate** — free, local keyword allow/block. The bulk of the filtering.
4. **Enrich** — pull the full advert from Reed for anything that passed, because
   the search endpoint only returns an excerpt.
5. **Body gate** — require remote wording, but only in text held in full.
6. **Score** — one Claude call per survivor (capped at 40), returning a score,
   a remote-confidence judgement, and the exact phrase that decided it.
7. **Digest** — email the matches via Resend. Sent even when empty, because
   silence is ambiguous.

## The portal

`https://jobs.foundry-ns.com` — behind Cloudflare Access, restricted to a single
Google account. Every posting is a rack-unit
strip: score readout, a three-segment remote-confidence meter, the quoted
evidence behind the remote judgement, and one-click status marking. Filter by
score, status, remote confidence, or free text.

The design splits type by provenance: monospace for everything the pipeline
measured, sans for everything a human wrote.

## Endpoints

Cloudflare Access fronts the whole hostname, so every route needs a signed-in
session. The HMAC on the two email-reachable routes is kept as a second layer.

| Route | Auth | Purpose |
|---|---|---|
| `/` | Access | The portal |
| `/health` | Access | Last run, table list, build marker |
| `/track` | Access + HMAC | Status links from the digest email |
| `/tailor` | Access + HMAC | Generate and email a tailored CV + cover letter |
| `/tailored` | Access | View a cached draft |
| `/run` | Access | Trigger a collection run now |
| `/weekly` | Access | Send the weekly application summary now |
| `/digest/preview` | Access | Render the digest email without sending it |

## Setup

```bash
npm install
npx wrangler d1 create job-monitor          # put the id in wrangler.toml
npm run db:schema                            # apply schema.sql
for k in REED_API_KEY ADZUNA_APP_ID ADZUNA_APP_KEY ANTHROPIC_API_KEY \
         RESEND_API_KEY TRACK_SIGNING_SECRET DIGEST_TO DIGEST_FROM; do
  npx wrangler secret put $k
done
npm run deploy
```

Then create a Cloudflare Access application for the hostname with an allow
policy for your account, and put its team domain and AUD tag into the `[vars]`
block in `wrangler.toml`. The Worker verifies the assertion Access forwards.

Cron triggers are declared in `wrangler.toml`: 06:00 UTC daily for collection,
07:00 UTC Sunday for the application summary. Cron is always UTC, so the daily
digest lands at 07:00 during British Summer Time.

## Tuning

`config/criteria.json` — keywords, thresholds, seed queries, models.
`config/profile.md` — the CV, passed into every scoring call.

Both are bundled at build time, so a change means a redeploy. If too little
reaches the digest, widen `titleAllow` or the seed queries before touching the
threshold; the prefilter is where roles are lost, not the scorer.

## Layout

```
src/
  index.ts            scheduled() and fetch() entry points
  sources/            reed.ts, adzuna.ts
  pipeline/           normalise, dedupe, prefilter, score, digest, tailor
  lib/                db, claude, email, sign, pool, config, types
  web/                portal.ts, styles.ts
config/               profile.md, criteria.json
migrations/           numbered, applied by hand
schema.sql            full shape for a fresh database
```

Each pipeline stage takes one shape of data and returns another, so a stage can
be tested or replaced without touching its neighbours. Swapping Reed for another
board means writing one file in `sources/`.
