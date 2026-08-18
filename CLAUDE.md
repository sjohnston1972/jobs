# Job Monitor — standing context

A Cloudflare Worker that polls UK job APIs daily, filters for genuinely remote
roles matching `config/profile.md`, scores survivors with Claude, and emails a
digest. State lives in D1. A private portal at `jobs.foundry-ns.com` shows
everything collected and tracks application status.

Build spec: `job-monitor-spec.md`. Read it before changing pipeline behaviour.

## Shape of the thing

```
Cron 06:00 UTC ──> scheduled() ──> fetch ──> dedupe ──> title gate
                                                          │
                                              enrich (Reed detail)
                                                          │
                                                     body gate
                                                          │
                                              score (Claude) ──> digest ──> Resend
fetch() serves  /            portal (Cloudflare Access)
                /track       signed status links from the digest
                /tailor      signed CV + cover letter draft
                /health      last run summary + build marker
```

The organising idea: a cheap local ACL (the keyword gates) in front of expensive
deep inspection (the Claude call), so AI spend only lands on plausible
candidates.

## Things that will bite you

**Deploys are not instant.** `wrangler deploy` returns before the new code is
serving everywhere. Two runs during this build silently executed the previous
version and produced confusing results. `BUILD` in `src/index.ts` is bumped by
hand and reported by `/health` — check it before trusting a test run:

```
curl https://jobs.foundry-ns.com/health   # confirm "build" before testing
```

**The body gate only sees full text.** Board search endpoints return an excerpt
and the remote statement usually sits below the cut, so testing an excerpt for
"remote" rejects genuinely remote roles. The prefilter is therefore two gates
with Reed enrichment between them, and `bodyGate` passes anything still marked
`description_truncated` to the scorer rather than judging it. Do not "simplify"
this back into one pass.

**Prefill and `temperature` are rejected on 4.6-and-later models.** Both calls
use structured outputs (`output_config.format`) instead. `supportsTemperature()`
in `src/lib/claude.ts` gates the sampling parameter by model.

**Fully remote is enforced in code, not just the prompt.** `scoreJob` caps any
posting at 39 when `remote_confidence` is `low`. The model drifted on this rule
during the build — a "98% remote, occasional travel to London" role scored 72.

**Day rates and salaries share two columns.** `salary_period` distinguishes
them; without it a £600/day contract renders as "£600". Always annualise before
comparing (`annualise()` in `pipeline/normalise.ts`).

**Three levels of dedupe.** `id`, then `content_hash` (title+employer+salary),
then `role_hash` (title+annualised salary, no employer) which collapses the same
role advertised by three different agencies.

## Working on it

```bash
npm run typecheck                       # tsc --noEmit, run before every deploy
npm run deploy                          # wrangler deploy
npm run db:schema                       # apply schema.sql (idempotent)
npx wrangler d1 execute job-monitor --remote --command "SELECT ..."
npx wrangler tail                       # live logs
```

Migrations are numbered files in `migrations/`, applied by hand with
`wrangler d1 execute --file=`. `schema.sql` is the current full shape for a
fresh database; it is not a migration runner. Apply a migration before
deploying the code that depends on it — a migration that adds a column a new
release reads or writes (e.g. `0003_settings_and_attendance.sql` and
`scores.attendance`) will otherwise make every run throw after the paid Claude
calls complete, silently skipping the digest until it is applied.

Tuning lives in `config/criteria.json` and `config/profile.md`. Both are bundled
into the Worker at build time, so editing them means redeploying — no migration,
no restart. Widening `titleAllow` or the seed queries is the first lever when
too little gets through; the threshold is the lever when too much does.

Manual endpoints (all need a portal session): `/run`, `/weekly`,
`/digest/preview?min=0&days=7` renders the digest email without sending it.

## Access and secrets

The whole hostname sits behind a Cloudflare Access application ("Job Monitor",
team `clydeford.cloudflareaccess.com`) with a single allow policy for
`stevie.johnston@gmail.com`, via Google or one-time PIN. There is no password
login in the Worker.

Access blocks unauthenticated requests at the edge, but `lib/access.ts` verifies
the forwarded JWT anyway — signature against the team JWKS, issuer, expiry and
AUD. "Something upstream is supposed to be handling it" is not an access
control, and the Worker holds both personal data and a live Anthropic key.

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are plain vars in `wrangler.toml`; the AUD
tag is a public identifier, not a secret. Every rejection logs its reason, so
`npx wrangler tail` distinguishes an expired assertion from an AUD mismatch.

Because `/health` is behind Access too, deploys can no longer be verified with
an unauthenticated `curl` — check `build` in a browser, or read `wrangler tail`.

Eight secrets, all pushed with `wrangler secret put` and never in the repo.
`.env` holds local copies and is gitignored.
