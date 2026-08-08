-- Adds the agency-duplicate dedupe key.
--
-- The first live run surfaced one "Infrastructure Architect" role advertised by
-- three separate agencies. Each has a different employer field, so both the id
-- and the content_hash differ and levels 1 and 2 of dedupe miss it. role_hash
-- drops the employer and keys on title + salary instead.
--
-- Existing rows keep role_hash NULL, which simply means they never collapse
-- anything. Apply with:
--   npx wrangler d1 execute job-monitor --remote --file=./migrations/0001_role_hash.sql

ALTER TABLE jobs ADD COLUMN role_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_role_hash ON jobs(role_hash);
