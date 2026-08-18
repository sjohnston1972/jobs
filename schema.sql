-- Job Monitor schema (D1 / SQLite)
-- Safe to re-run: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS jobs (
  id                    TEXT PRIMARY KEY,      -- "reed:40227781" or "adzuna:123456"
  source                TEXT NOT NULL,
  source_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  employer              TEXT,
  location_raw          TEXT,
  remote_flag           INTEGER,               -- what the source claims, not trusted
  contract_type         TEXT,                  -- permanent | contract | unknown
  salary_min            REAL,
  salary_max            REAL,
  salary_period         TEXT DEFAULT 'unknown', -- annual | daily | unknown
  salary_predicted      INTEGER DEFAULT 0,
  currency              TEXT,
  url                   TEXT NOT NULL,
  description           TEXT,
  description_truncated INTEGER DEFAULT 0,
  posted_at             TEXT,
  first_seen_at         TEXT NOT NULL,
  content_hash          TEXT NOT NULL,         -- normalised title + employer + salary
  role_hash             TEXT                   -- normalised title + salary, collapses agency duplicates
);
CREATE INDEX IF NOT EXISTS idx_jobs_hash ON jobs(content_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_role_hash ON jobs(role_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_seen ON jobs(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs(posted_at);

CREATE TABLE IF NOT EXISTS scores (
  job_id            TEXT PRIMARY KEY REFERENCES jobs(id),
  score             INTEGER NOT NULL,    -- 0 to 100, or -1 when the model output failed to parse
  remote_confidence TEXT,                -- high | medium | low
  remote_evidence   TEXT,                -- the phrase the model relied on
  ir35_signal       TEXT,                -- inside | outside | unstated | n/a
  seniority_fit     TEXT,                -- below | match | above
  attendance        TEXT,                -- none | occasional | fixed | onsite | unstated
  reason            TEXT,                -- one line
  red_flags         TEXT,                -- JSON array
  model             TEXT,
  scored_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_scored_at ON scores(scored_at);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score);

-- Sparse overrides for config/criteria.json. Only fields actually changed in
-- the portal get a row; everything else continues to track the bundled file,
-- so editing criteria.json and redeploying still works for anything untouched.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,   -- a Criteria field name
  value      TEXT NOT NULL,      -- JSON-encoded scalar or array
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(id),
  status      TEXT NOT NULL,             -- interested | applied | rejected | interviewing | closed
  applied_at  TEXT,
  notes       TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

CREATE TABLE IF NOT EXISTS runs (
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
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);

-- Tailored CV / cover letter drafts, cached so a re-request is free.
CREATE TABLE IF NOT EXISTS tailored (
  job_id       TEXT PRIMARY KEY REFERENCES jobs(id),
  cv_summary   TEXT,
  cover_letter TEXT,
  model        TEXT,
  created_at   TEXT NOT NULL
);
