import type {
  ApplicationStatus,
  Attendance,
  JobRow,
  NormalisedJob,
  PortalJob,
  RunCounts,
  ScoreResult,
  ScoredJob,
} from './types';
import { UNSCORED_SOURCES } from './types';

/** SQLite caps bound parameters per statement; chunk anything variable-length. */
const PARAM_CHUNK = 90;

/**
 * `AND <column> NOT IN (?,?)` for the sources that are never scored, with the
 * binds that go with it. Expressed once so the SQL and the in-memory filter in
 * runPipeline cannot drift apart. Empty when the list is empty, because
 * `NOT IN ()` is a syntax error rather than a no-op.
 */
function excludeUnscored(column: string): { sql: string; binds: string[] } {
  if (!UNSCORED_SOURCES.length) return { sql: '', binds: [] };
  const placeholders = UNSCORED_SOURCES.map(() => '?').join(',');
  return { sql: ` AND ${column} NOT IN (${placeholders})`, binds: [...UNSCORED_SOURCES] };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------- runs

export async function startRun(db: D1Database): Promise<number> {
  const row = await db
    .prepare('INSERT INTO runs (started_at) VALUES (?) RETURNING id')
    .bind(nowIso())
    .first<{ id: number }>();
  return row!.id;
}

export async function finishRun(
  db: D1Database,
  runId: number,
  counts: RunCounts,
  errors: string[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs SET finished_at = ?, fetched = ?, new_jobs = ?, prefiltered = ?,
              scored = ?, digested = ?, errors = ? WHERE id = ?`,
    )
    .bind(
      nowIso(),
      counts.fetched,
      counts.new_jobs,
      counts.prefiltered,
      counts.scored,
      counts.digested,
      errors.length ? JSON.stringify(errors) : null,
      runId,
    )
    .run();
}

export async function getLastRun(db: D1Database) {
  return db
    .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1')
    .first<Record<string, unknown>>();
}

export async function getRecentRuns(db: D1Database, limit = 14) {
  const { results } = await db
    .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<Record<string, unknown>>();
  return results ?? [];
}

// ---------------------------------------------------------------- dedupe

export async function getExistingIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of chunk(ids, PARAM_CHUNK)) {
    const placeholders = group.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT id FROM jobs WHERE id IN (${placeholders})`)
      .bind(...group)
      .all<{ id: string }>();
    for (const r of results ?? []) found.add(r.id);
  }
  return found;
}

/**
 * Hashes that an incoming posting is allowed to be rejected against. Rows from
 * sources that are never scored are left out: a LinkedIn lead carries no
 * description, so if it were allowed to hold the window it would drop the Reed
 * posting for the same role — and since the lead can never be scored, the role
 * would vanish from the pipeline entirely.
 */
export async function getRecentHashes(db: D1Database, sinceIso: string): Promise<Set<string>> {
  const skip = excludeUnscored('source');
  const { results } = await db
    .prepare(`SELECT DISTINCT content_hash FROM jobs WHERE first_seen_at >= ?${skip.sql}`)
    .bind(sinceIso, ...skip.binds)
    .all<{ content_hash: string }>();
  return new Set((results ?? []).map((r) => r.content_hash));
}

export async function getRecentRoleHashes(db: D1Database, sinceIso: string): Promise<Set<string>> {
  const skip = excludeUnscored('source');
  const { results } = await db
    .prepare(
      `SELECT DISTINCT role_hash FROM jobs
       WHERE first_seen_at >= ? AND role_hash IS NOT NULL${skip.sql}`,
    )
    .bind(sinceIso, ...skip.binds)
    .all<{ role_hash: string }>();
  return new Set((results ?? []).map((r) => r.role_hash));
}

export async function insertJobs(
  db: D1Database,
  jobs: NormalisedJob[],
  seenAt: string,
): Promise<number> {
  if (!jobs.length) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO jobs (
       id, source, source_id, title, employer, location_raw, remote_flag,
       contract_type, salary_min, salary_max, salary_period, salary_predicted, currency, url,
       description, description_truncated, posted_at, first_seen_at, content_hash, role_hash
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const batch = jobs.map((j) =>
    stmt.bind(
      j.id, j.source, j.source_id, j.title, j.employer, j.location_raw, j.remote_flag,
      j.contract_type, j.salary_min, j.salary_max, j.salary_period, j.salary_predicted,
      j.currency, j.url, j.description, j.description_truncated, j.posted_at, seenAt,
      j.content_hash, j.role_hash,
    ),
  );
  for (const group of chunk(batch, 20)) await db.batch(group);
  return jobs.length;
}

// ---------------------------------------------------------------- scoring

/**
 * Anything stored but never scored, newest first. Prefilter is re-applied to
 * these in memory each run, which is free and means a criteria.json edit
 * automatically reconsiders the backlog. It also gives carryover for nothing:
 * jobs beyond maxScoredPerRun simply reappear here tomorrow.
 */
export async function getUnscoredJobs(
  db: D1Database,
  sinceIso: string,
  limit = 500,
): Promise<JobRow[]> {
  // Sources that are never scored are excluded here rather than only in
  // memory. They are dated to the alert email, so they sort to the front of
  // this ordering and would otherwise be permanently resident at the top of
  // the limit, spending it on rows that can never leave this query.
  const skip = excludeUnscored('j.source');
  const { results } = await db
    .prepare(
      `SELECT j.* FROM jobs j
       LEFT JOIN scores s ON s.job_id = j.id
       WHERE s.job_id IS NULL AND j.first_seen_at >= ?${skip.sql}
       ORDER BY COALESCE(j.posted_at, j.first_seen_at) DESC
       LIMIT ?`,
    )
    .bind(sinceIso, ...skip.binds, limit)
    .all<JobRow>();
  return results ?? [];
}

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
       WHERE j.first_seen_at >= ?
         AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id)`,
    )
    .bind(sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Deletes scores for jobs still inside the lookback window, same bound as
 * countRescorable. Excludes jobs with an applications row: the portal's
 * default view and the weekly active-applications summary both inner-join
 * scores, so deleting the score for a job the owner marked applied would
 * evict it from both — one click, no confirmation, irreversible until a
 * later run rescores it. The count and the delete must stay in agreement, so
 * this guard has to change in lockstep with the one in countRescorable.
 */
export async function clearScoresSince(db: D1Database, sinceIso: string): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM scores WHERE job_id IN (
         SELECT j.id FROM jobs j WHERE j.first_seen_at >= ?
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id)
       )`,
    )
    .bind(sinceIso)
    .run();
  return result.meta?.changes ?? 0;
}

export async function insertScore(
  db: D1Database,
  jobId: string,
  result: ScoreResult,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO scores (
         job_id, score, remote_confidence, remote_evidence, ir35_signal,
         seniority_fit, attendance, reason, red_flags, model, scored_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      jobId,
      result.score,
      result.remote_confidence,
      result.remote_evidence,
      result.ir35_signal,
      result.seniority_fit,
      result.attendance,
      result.reason,
      JSON.stringify(result.red_flags ?? []),
      result.model,
      nowIso(),
    )
    .run();
}

// ---------------------------------------------------------------- reads

function selectWith(scoresJoin: 'JOIN' | 'LEFT JOIN'): string {
  return `
  SELECT j.*, s.score, s.remote_confidence, s.remote_evidence, s.ir35_signal,
         s.seniority_fit, s.attendance, s.reason, s.red_flags, s.scored_at,
         a.status, a.updated_at AS status_updated_at, a.notes
  FROM jobs j
  ${scoresJoin} scores s ON s.job_id = j.id
  LEFT JOIN applications a ON a.job_id = j.id`;
}

/** The scored view. The inner join is what keeps unscored rows out of the digest. */
const SCORED_SELECT = selectWith('JOIN');

/**
 * The same shape with the score optional, so postings from UNSCORED_SOURCES —
 * which by design never get a scores row — can be listed. Only getPortalJobs
 * uses it, and only when the request explicitly asks for leads. The digest
 * queries stay on SCORED_SELECT and must.
 */
const LEADS_SELECT = selectWith('LEFT JOIN');

function toPortalJob(row: Record<string, unknown>): PortalJob {
  let flags: string[] = [];
  try {
    const parsed = JSON.parse((row.red_flags as string) || '[]');
    if (Array.isArray(parsed)) flags = parsed.map(String);
  } catch {
    // A malformed array is not worth failing a page render over.
  }
  return {
    ...(row as unknown as PortalJob),
    red_flags: flags,
    // A leads row has no scores row at all. Left as null so the UI can say so
    // rather than printing a 0, which would read as "assessed and rejected".
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    attendance: (row.attendance as Attendance | null) ?? null,
  };
}

/** Rows from a query that inner-joins scores always carry one. */
function toScoredJob(row: Record<string, unknown>): ScoredJob {
  return toPortalJob(row) as ScoredJob;
}

/** Everything scored during this run at or above the digest threshold. */
export async function getDigestJobs(
  db: D1Database,
  scoredSinceIso: string,
  minScore: number,
): Promise<ScoredJob[]> {
  const { results } = await db
    .prepare(`${SCORED_SELECT} WHERE s.scored_at >= ? AND s.score >= ? ORDER BY s.score DESC`)
    .bind(scoredSinceIso, minScore)
    .all<Record<string, unknown>>();
  return (results ?? []).map(toScoredJob);
}

/** Scored below the threshold this run — the "filtered out" line in the digest. */
export async function getBelowThreshold(
  db: D1Database,
  scoredSinceIso: string,
  minScore: number,
): Promise<ScoredJob[]> {
  const { results } = await db
    .prepare(`${SCORED_SELECT} WHERE s.scored_at >= ? AND s.score < ? ORDER BY s.score DESC`)
    .bind(scoredSinceIso, minScore)
    .all<Record<string, unknown>>();
  return (results ?? []).map(toScoredJob);
}

export interface PortalFilter {
  minScore?: number;
  status?: string;
  source?: string;
  contract?: string;
  remote?: string;
  search?: string;
  sort?: 'score' | 'posted' | 'seen';
  /**
   * Include postings that have never been scored. Off unless the request asks
   * for it, so the default portal view is exactly what it was before leads
   * existed.
   */
  leads?: boolean;
  limit?: number;
}

/** True when a request has explicitly asked to see rows that cannot be scored. */
export function wantsLeads(leadsParam: string | null, source: string | undefined): boolean {
  // A ?source= naming an unscored source is as explicit an ask as ?leads=1,
  // and without this that filter would return an empty page every time.
  return leadsParam === '1' || (source !== undefined && UNSCORED_SOURCES.includes(source));
}

export async function getPortalJobs(
  db: D1Database,
  filter: PortalFilter,
): Promise<PortalJob[]> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filter.minScore !== undefined) {
    where.push('s.score >= ?');
    binds.push(filter.minScore);
  }
  if (filter.status) {
    if (filter.status === 'none') where.push('a.status IS NULL');
    else if (filter.status === 'tracked') where.push("a.status IS NOT NULL AND a.status != 'closed'");
    else {
      where.push('a.status = ?');
      binds.push(filter.status);
    }
  }
  if (filter.source) {
    where.push('j.source = ?');
    binds.push(filter.source);
  }
  if (filter.contract) {
    where.push('j.contract_type = ?');
    binds.push(filter.contract);
  }
  if (filter.remote) {
    where.push('s.remote_confidence = ?');
    binds.push(filter.remote);
  }
  if (filter.search) {
    where.push('(LOWER(j.title) LIKE ? OR LOWER(j.employer) LIKE ?)');
    const term = `%${filter.search.toLowerCase()}%`;
    binds.push(term, term);
  }

  const order =
    filter.sort === 'posted'
      ? 'COALESCE(j.posted_at, j.first_seen_at) DESC'
      : filter.sort === 'seen'
        ? 'j.first_seen_at DESC'
        : 's.score DESC, COALESCE(j.posted_at, j.first_seen_at) DESC';

  const sql =
    (filter.leads ? LEADS_SELECT : SCORED_SELECT) +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${order} LIMIT ?`;
  binds.push(filter.limit ?? 200);

  const { results } = await db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return (results ?? []).map(toPortalJob);
}

export async function getScoredJob(db: D1Database, id: string): Promise<ScoredJob | null> {
  const row = await db
    .prepare(`${SCORED_SELECT} WHERE j.id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? toScoredJob(row) : null;
}

export async function getJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
}

// ---------------------------------------------------------------- applications

export async function upsertApplication(
  db: D1Database,
  jobId: string,
  status: ApplicationStatus,
  notes?: string | null,
): Promise<void> {
  const ts = nowIso();
  const appliedAt = status === 'applied' ? ts : null;
  await db
    .prepare(
      `INSERT INTO applications (job_id, status, applied_at, notes, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(job_id) DO UPDATE SET
         status = excluded.status,
         applied_at = COALESCE(applications.applied_at, excluded.applied_at),
         notes = COALESCE(excluded.notes, applications.notes),
         updated_at = excluded.updated_at`,
    )
    .bind(jobId, status, appliedAt, notes ?? null, ts)
    .run();
}

export async function getActiveApplications(db: D1Database): Promise<ScoredJob[]> {
  const { results } = await db
    .prepare(
      `${SCORED_SELECT} WHERE a.status IN ('applied','interviewing')
       ORDER BY a.updated_at ASC`,
    )
    .all<Record<string, unknown>>();
  return (results ?? []).map(toScoredJob);
}

// ---------------------------------------------------------------- tailoring

export async function getTailored(db: D1Database, jobId: string) {
  return db
    .prepare('SELECT * FROM tailored WHERE job_id = ?')
    .bind(jobId)
    .first<{ cv_summary: string; cover_letter: string; model: string; created_at: string }>();
}

export async function saveTailored(
  db: D1Database,
  jobId: string,
  cvSummary: string,
  coverLetter: string,
  model: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO tailored (job_id, cv_summary, cover_letter, model, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .bind(jobId, cvSummary, coverLetter, model, nowIso())
    .run();
}

// ---------------------------------------------------------------- stats

export interface PortalStats {
  total_jobs: number;
  total_scored: number;
  matches: number;
  tracked: number;
  applied: number;
  interviewing: number;
  new_today: number;
}

export async function getStats(db: D1Database, minScore: number): Promise<PortalStats> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM jobs) AS total_jobs,
         (SELECT COUNT(*) FROM scores) AS total_scored,
         (SELECT COUNT(*) FROM scores WHERE score >= ?1) AS matches,
         (SELECT COUNT(*) FROM applications WHERE status IS NOT NULL AND status != 'closed') AS tracked,
         (SELECT COUNT(*) FROM applications WHERE status = 'applied') AS applied,
         (SELECT COUNT(*) FROM applications WHERE status = 'interviewing') AS interviewing,
         (SELECT COUNT(*) FROM jobs WHERE first_seen_at >= ?2) AS new_today`,
    )
    .bind(minScore, midnight.toISOString())
    .first<PortalStats>();
  return (
    row ?? {
      total_jobs: 0, total_scored: 0, matches: 0,
      tracked: 0, applied: 0, interviewing: 0, new_today: 0,
    }
  );
}

export async function listTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all<{ name: string }>();
  return (results ?? []).map((r) => r.name);
}
