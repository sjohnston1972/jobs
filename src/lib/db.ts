import type {
  ApplicationStatus,
  JobRow,
  NormalisedJob,
  RunCounts,
  ScoreResult,
  ScoredJob,
} from './types';

/** SQLite caps bound parameters per statement; chunk anything variable-length. */
const PARAM_CHUNK = 90;

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

export async function getRecentHashes(db: D1Database, sinceIso: string): Promise<Set<string>> {
  const { results } = await db
    .prepare('SELECT DISTINCT content_hash FROM jobs WHERE first_seen_at >= ?')
    .bind(sinceIso)
    .all<{ content_hash: string }>();
  return new Set((results ?? []).map((r) => r.content_hash));
}

export async function getRecentRoleHashes(db: D1Database, sinceIso: string): Promise<Set<string>> {
  const { results } = await db
    .prepare('SELECT DISTINCT role_hash FROM jobs WHERE first_seen_at >= ? AND role_hash IS NOT NULL')
    .bind(sinceIso)
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
  const { results } = await db
    .prepare(
      `SELECT j.* FROM jobs j
       LEFT JOIN scores s ON s.job_id = j.id
       WHERE s.job_id IS NULL AND j.first_seen_at >= ?
       ORDER BY COALESCE(j.posted_at, j.first_seen_at) DESC
       LIMIT ?`,
    )
    .bind(sinceIso, limit)
    .all<JobRow>();
  return results ?? [];
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
         seniority_fit, reason, red_flags, model, scored_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      jobId,
      result.score,
      result.remote_confidence,
      result.remote_evidence,
      result.ir35_signal,
      result.seniority_fit,
      result.reason,
      JSON.stringify(result.red_flags ?? []),
      result.model,
      nowIso(),
    )
    .run();
}

// ---------------------------------------------------------------- reads

const SCORED_SELECT = `
  SELECT j.*, s.score, s.remote_confidence, s.remote_evidence, s.ir35_signal,
         s.seniority_fit, s.reason, s.red_flags, s.scored_at,
         a.status, a.updated_at AS status_updated_at, a.notes
  FROM jobs j
  JOIN scores s ON s.job_id = j.id
  LEFT JOIN applications a ON a.job_id = j.id`;

function toScoredJob(row: Record<string, unknown>): ScoredJob {
  let flags: string[] = [];
  try {
    const parsed = JSON.parse((row.red_flags as string) || '[]');
    if (Array.isArray(parsed)) flags = parsed.map(String);
  } catch {
    // A malformed array is not worth failing a page render over.
  }
  return { ...(row as unknown as ScoredJob), red_flags: flags };
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
  limit?: number;
}

export async function getPortalJobs(
  db: D1Database,
  filter: PortalFilter,
): Promise<ScoredJob[]> {
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
    SCORED_SELECT +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${order} LIMIT ?`;
  binds.push(filter.limit ?? 200);

  const { results } = await db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return (results ?? []).map(toScoredJob);
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
