import { criteria, profile } from './lib/config';
import * as db from './lib/db';
import { sendEmail } from './lib/email';
import { pool } from './lib/pool';
import { issueSession, verify, verifySession } from './lib/sign';
import type { Env, JobRow, NormalisedJob, RunCounts, ApplicationStatus } from './lib/types';
import { APPLICATION_STATUSES } from './lib/types';
import { fetchAdzuna } from './sources/adzuna';
import { fetchReed, fetchReedDescription } from './sources/reed';
import { dedupe } from './pipeline/dedupe';
import { buildDigest, buildWeeklySummary } from './pipeline/digest';
import { applyBodyGate, applyTitleGate } from './pipeline/prefilter';
import { scoreJob } from './pipeline/score';
import { tailorForJob, tailoredEmail } from './pipeline/tailor';
import {
  layout,
  renderGate,
  renderMessage,
  renderPortal,
  renderTailored,
  renderTrackConfirm,
} from './web/portal';

/**
 * Bumped by hand whenever pipeline behaviour changes. /health reports it, so
 * "is the fix actually live?" is a question with an answer rather than a guess.
 */
export const BUILD = 'v6-structured-outputs';

const SESSION_COOKIE = 'jm_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const SCORING_CONCURRENCY = 3;
/** Bounds the subrequest count: one detail call per title-matching Reed job. */
const MAX_ENRICH_PER_RUN = 60;

// =====================================================================
// Pipeline
// =====================================================================

export async function runPipeline(env: Env): Promise<RunCounts & { errors: string[] }> {
  const runId = await db.startRun(env.DB);
  const runStartedAt = db.nowIso();
  const errors: string[] = [];
  const counts: RunCounts = { fetched: 0, new_jobs: 0, prefiltered: 0, scored: 0, digested: 0 };

  // -- Stage 1: fetch. One dead API must never suppress the digest.
  const collected: NormalisedJob[] = [];
  for (const query of criteria.seedQueries) {
    try {
      collected.push(...(await fetchReed(env.REED_API_KEY, query, criteria.lookbackDays)));
    } catch (err) {
      errors.push(String(err));
    }
    try {
      collected.push(
        ...(await fetchAdzuna(env.ADZUNA_APP_ID, env.ADZUNA_APP_KEY, query, criteria.lookbackDays)),
      );
    } catch (err) {
      errors.push(String(err));
    }
  }
  counts.fetched = collected.length;

  // -- Stages 2 and 3: normalise happened in the collectors; dedupe and store.
  try {
    const result = await dedupe(env.DB, collected);
    await db.insertJobs(env.DB, result.fresh, runStartedAt);
    counts.new_jobs = result.fresh.length;
    console.log(
      `dedupe: ${collected.length} in, ${result.fresh.length} fresh`,
      JSON.stringify({
        by_source_id: result.bySourceId,
        by_content_hash: result.byContentHash,
        by_role_hash: result.byRoleHash,
        within_batch: result.withinBatch,
      }),
    );
  } catch (err) {
    errors.push(`dedupe/insert: ${String(err)}`);
  }

  // -- Stage 4: prefilter, in two gates with enrichment between them.
  //
  //    The body gate has to see the whole advert. Board search endpoints return
  //    an excerpt and the remote statement usually sits below the cut, so
  //    running the remote check first rejects genuinely remote roles on the
  //    accident of where a summary ended. The title gate is free and does the
  //    heavy lifting, so it goes first and decides what is worth a detail call.
  let toScore: JobRow[] = [];
  try {
    const unscored = await db.getUnscoredJobs(env.DB, db.daysAgoIso(criteria.lookbackDays + 3));
    const titled = applyTitleGate(unscored, criteria);

    // -- Stage 4b: enrich. Only Reed exposes a detail endpoint; Adzuna excerpts
    //    stay truncated and are deferred to the scorer by the body gate.
    const needsFullText = titled.passed
      .filter((j) => j.source === 'reed' && j.description_truncated)
      .slice(0, MAX_ENRICH_PER_RUN);

    let enriched = 0;
    await pool(needsFullText, SCORING_CONCURRENCY, async (job) => {
      try {
        const full = await fetchReedDescription(env.REED_API_KEY, job.source_id);
        if (full && full.length > (job.description ?? '').length) {
          job.description = full;
          job.description_truncated = 0;
          enriched++;
          await env.DB.prepare(
            'UPDATE jobs SET description = ?, description_truncated = 0 WHERE id = ?',
          )
            .bind(full, job.id)
            .run();
        }
      } catch {
        // The excerpt still scores; a failed enrich is not worth failing the run.
      }
    });

    const bodied = applyBodyGate(titled.passed, criteria);
    counts.prefiltered = bodied.passed.length;
    console.log(
      `prefilter: ${unscored.length} considered, ${titled.passed.length} passed title, ` +
        `${enriched} enriched, ${bodied.passed.length} passed body`,
      JSON.stringify({ ...titled.counts, ...bodied.counts }),
    );
    toScore = bodied.passed.slice(0, criteria.maxScoredPerRun);
  } catch (err) {
    errors.push(`prefilter: ${String(err)}`);
  }

  // -- Stage 5: score.
  try {
    const results = await pool(toScore, SCORING_CONCURRENCY, (job) =>
      scoreJob(env.ANTHROPIC_API_KEY, job, profile, criteria),
    );
    for (let i = 0; i < toScore.length; i++) {
      await db.insertScore(env.DB, toScore[i].id, results[i]);
    }
    counts.scored = toScore.length;
    const failed = results.filter((r) => r.score === -1).length;
    if (failed) errors.push(`${failed} of ${results.length} scoring calls failed to parse`);
  } catch (err) {
    errors.push(`score: ${String(err)}`);
  }

  // -- Stage 6: digest. Sent even when empty — silence is ambiguous.
  try {
    const matches = await db.getDigestJobs(env.DB, runStartedAt, criteria.minScoreForDigest);
    const below = await db.getBelowThreshold(env.DB, runStartedAt, criteria.minScoreForDigest);
    const digest = await buildDigest(
      matches, below, counts, criteria, siteUrl(env), env.TRACK_SIGNING_SECRET,
    );
    await sendEmail(env.RESEND_API_KEY, {
      to: env.DIGEST_TO,
      from: env.DIGEST_FROM,
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
    });
    counts.digested = matches.length;
  } catch (err) {
    errors.push(`digest: ${String(err)}`);
  }

  await db.finishRun(env.DB, runId, counts, errors);
  console.log('run complete', JSON.stringify({ runId, ...counts, errors }));
  return { ...counts, errors };
}

async function runWeeklySummary(env: Env): Promise<void> {
  const active = await db.getActiveApplications(env.DB);
  const summary = await buildWeeklySummary(active, siteUrl(env));
  await sendEmail(env.RESEND_API_KEY, {
    to: env.DIGEST_TO,
    from: env.DIGEST_FROM,
    subject: summary.subject,
    text: summary.text,
    html: summary.html,
  });
}

function siteUrl(env: Env): string {
  const raw = env.SITE_URL || 'https://jobs.foundry-ns.com';
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

// =====================================================================
// HTTP helpers
// =====================================================================

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function isSignedIn(request: Request, env: Env): Promise<boolean> {
  return verifySession(env.TRACK_SIGNING_SECRET, readCookie(request, SESSION_COOKIE), Date.now());
}

/** Verifies the `sig` on links that arrive from an email. */
async function checkSignature(url: URL, env: Env, fields: string[]): Promise<boolean> {
  const payload = fields.map((f) => url.searchParams.get(f) ?? '').join('|');
  return verify(env.TRACK_SIGNING_SECRET, payload, url.searchParams.get('sig') ?? '');
}

// =====================================================================
// Worker
// =====================================================================

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two triggers share one handler: the daily collection and the Sunday summary.
    if (event.cron === '0 7 * * SUN') {
      ctx.waitUntil(runWeeklySummary(env));
      return;
    }
    ctx.waitUntil(runPipeline(env).then(() => undefined));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // ---------------------------------------------------------- health
      if (path === '/health') {
        const [tables, lastRun] = await Promise.all([
          db.listTables(env.DB),
          db.getLastRun(env.DB),
        ]);
        const finishedAt = lastRun?.finished_at ?? lastRun?.started_at;
        const ageHours = finishedAt
          ? Math.round((Date.now() - Date.parse(String(finishedAt))) / 3_600_000)
          : null;
        return json({
          status: ageHours !== null && ageHours < 30 ? 'ok' : 'stale',
          build: BUILD,
          tables,
          last_run: lastRun ?? null,
          last_run_age_hours: ageHours,
          site: siteUrl(env),
        });
      }

      // ---------------------------------------------------------- auth
      if (path === '/login' && request.method === 'POST') {
        const form = await request.formData();
        const supplied = String(form.get('password') ?? '');
        if (!env.PORTAL_PASSWORD || supplied !== env.PORTAL_PASSWORD) {
          return html(renderGate('That password was not recognised.'), 401);
        }
        const token = await issueSession(env.TRACK_SIGNING_SECRET, SESSION_TTL, Date.now());
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie':
              `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
          },
        });
      }

      if (path === '/logout') {
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          },
        });
      }

      // ---------------------------------------------------------- track
      // Signed link from the digest. Without the signature this endpoint is an
      // open write to the database for anyone who guesses the URL.
      if (path === '/track') {
        const jobId = url.searchParams.get('job') ?? '';
        const status = url.searchParams.get('status') ?? '';
        if (!(await checkSignature(url, env, ['job', 'status']))) {
          return html(renderMessage('Link rejected', 'That link is not correctly signed.'), 403);
        }
        if (!APPLICATION_STATUSES.includes(status as ApplicationStatus)) {
          return html(renderMessage('Unknown status', `"${status}" is not a status this tracks.`), 400);
        }
        await db.upsertApplication(env.DB, jobId, status as ApplicationStatus);
        const job = await db.getScoredJob(env.DB, jobId);
        return html(renderTrackConfirm(job, status));
      }

      // ---------------------------------------------------------- tailor (signed, from email)
      if (path === '/tailor') {
        const jobId = url.searchParams.get('job') ?? '';
        if (!(await checkSignature(url, env, ['job']))) {
          return html(renderMessage('Link rejected', 'That link is not correctly signed.'), 403);
        }
        const result = await ensureTailored(env, jobId);
        if ('error' in result) return html(renderMessage('Could not tailor', result.error), 502);

        // The signed link is designed to be clicked from a phone, so the draft
        // is emailed as well as shown.
        ctx.waitUntil(
          sendEmail(env.RESEND_API_KEY, {
            to: env.DIGEST_TO,
            from: env.DIGEST_FROM,
            ...tailoredEmail(result.job, {
              cvSummary: result.cvSummary,
              coverLetter: result.coverLetter,
              model: result.model,
            }),
          }).catch((err) => console.error('tailor email failed', err)),
        );

        const scored = await db.getScoredJob(env.DB, jobId);
        return html(
          renderTailored(
            scored ?? ({ ...result.job, score: 0 } as never),
            result.cvSummary,
            result.coverLetter,
            result.model,
            db.nowIso(),
          ),
        );
      }

      // ---------------------------------------------------------- everything below needs a session
      const signedIn = await isSignedIn(request, env);

      if (path === '/tailored') {
        if (!signedIn) return html(renderGate(), 401);
        const jobId = url.searchParams.get('job') ?? '';
        const [scored, cached] = await Promise.all([
          db.getScoredJob(env.DB, jobId),
          db.getTailored(env.DB, jobId),
        ]);
        if (!scored) return html(renderMessage('Not found', 'No posting with that id.'), 404);
        if (!cached) {
          return html(renderMessage('No draft yet', 'Nothing has been tailored for this posting.'), 404);
        }
        return html(
          renderTailored(scored, cached.cv_summary, cached.cover_letter, cached.model, cached.created_at),
        );
      }

      if (path === '/api/status' && request.method === 'POST') {
        if (!signedIn) return json({ error: 'not signed in' }, 401);
        const body = (await request.json()) as { job?: string; status?: string; notes?: string };
        const status = String(body.status ?? '');
        if (!body.job || !APPLICATION_STATUSES.includes(status as ApplicationStatus)) {
          return json({ error: 'job and a known status are required' }, 400);
        }
        await db.upsertApplication(env.DB, body.job, status as ApplicationStatus, body.notes ?? null);
        return json({ ok: true, job: body.job, status });
      }

      if (path === '/api/tailor' && request.method === 'POST') {
        if (!signedIn) return json({ error: 'not signed in' }, 401);
        const body = (await request.json()) as { job?: string };
        if (!body.job) return json({ error: 'job is required' }, 400);
        const result = await ensureTailored(env, body.job);
        if ('error' in result) return json({ error: result.error }, 502);
        return json({ ok: true, job: body.job, model: result.model });
      }

      if (path === '/run') {
        if (!signedIn) return json({ error: 'not signed in' }, 401);
        const result = await runPipeline(env);
        return json({ ok: true, ...result });
      }

      // Renders the digest exactly as it would be emailed, without sending it.
      // ?min= overrides the threshold and ?days= widens the window, so the
      // layout can be checked on a day when nothing actually matched.
      if (path === '/digest/preview') {
        if (!signedIn) return json({ error: 'not signed in' }, 401);
        const min = Number(url.searchParams.get('min') ?? criteria.minScoreForDigest);
        const days = Number(url.searchParams.get('days') ?? 1);
        const since = db.daysAgoIso(Number.isFinite(days) ? days : 1);
        const threshold = Number.isFinite(min) ? min : criteria.minScoreForDigest;

        const [matches, below, lastRun] = await Promise.all([
          db.getDigestJobs(env.DB, since, threshold),
          db.getBelowThreshold(env.DB, since, threshold),
          db.getLastRun(env.DB),
        ]);
        const digest = await buildDigest(
          matches,
          below,
          {
            fetched: Number(lastRun?.fetched ?? 0),
            new_jobs: Number(lastRun?.new_jobs ?? 0),
            prefiltered: Number(lastRun?.prefiltered ?? 0),
            scored: Number(lastRun?.scored ?? 0),
            digested: matches.length,
          },
          { ...criteria, minScoreForDigest: threshold },
          siteUrl(env),
          env.TRACK_SIGNING_SECRET,
        );
        return html(digest.html);
      }

      if (path === '/weekly') {
        if (!signedIn) return json({ error: 'not signed in' }, 401);
        await runWeeklySummary(env);
        return json({ ok: true });
      }

      // ---------------------------------------------------------- portal
      if (path === '/') {
        if (!signedIn) return html(renderGate());

        const minRaw = url.searchParams.get('min');
        const filter = {
          minScore: minRaw !== null && minRaw !== '' ? Number(minRaw) : undefined,
          status: url.searchParams.get('status') ?? undefined,
          source: url.searchParams.get('source') ?? undefined,
          contract: url.searchParams.get('contract') ?? undefined,
          remote: url.searchParams.get('remote') ?? undefined,
          search: url.searchParams.get('q') ?? undefined,
          sort: (url.searchParams.get('sort') as 'score' | 'posted' | 'seen' | null) ?? undefined,
          limit: 200,
        };

        const [jobs, stats, lastRun] = await Promise.all([
          db.getPortalJobs(env.DB, filter),
          db.getStats(env.DB, criteria.minScoreForDigest),
          db.getLastRun(env.DB),
        ]);

        return html(renderPortal(jobs, stats, filter, criteria, lastRun ?? null));
      }

      return html(renderMessage('Not found', `Nothing is served at ${path}.`), 404);
    } catch (err) {
      console.error('request failed', path, err);
      return html(
        layout(
          'Error — Job Monitor',
          `<div class="prose"><h1>Something failed</h1>
           <p style="color:var(--dim)">${String(err).slice(0, 400)}</p>
           <p style="margin-top:24px"><a href="/">Back to the portal</a></p></div>`,
        ),
        500,
      );
    }
  },
};

/** Returns the cached draft when there is one, otherwise writes a new one. */
async function ensureTailored(
  env: Env,
  jobId: string,
): Promise<
  | { job: JobRow; cvSummary: string; coverLetter: string; model: string }
  | { error: string }
> {
  const job = await db.getJob(env.DB, jobId);
  if (!job) return { error: 'No posting with that id.' };

  const cached = await db.getTailored(env.DB, jobId);
  if (cached) {
    return {
      job,
      cvSummary: cached.cv_summary,
      coverLetter: cached.cover_letter,
      model: cached.model,
    };
  }

  try {
    const draft = await tailorForJob(env.ANTHROPIC_API_KEY, job, profile, criteria);
    await db.saveTailored(env.DB, jobId, draft.cvSummary, draft.coverLetter, draft.model);
    return { job, cvSummary: draft.cvSummary, coverLetter: draft.coverLetter, model: draft.model };
  } catch (err) {
    return { error: String(err).slice(0, 400) };
  }
}
