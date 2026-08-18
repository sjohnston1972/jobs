-- Adds settings table and scores.attendance column for runtime tuning.
--
-- Enables runtime tuning of digest criteria without redeployment. Previously,
-- changes to scoring thresholds and eligibility rules required a rebuild; now
-- they can be applied immediately from the portal.
--
-- Apply with:
--   npx wrangler d1 execute job-monitor --remote --file=./migrations/0003_settings_and_attendance.sql

-- Sparse overrides for config/criteria.json. Only fields actually changed in
-- the portal get a row; everything else continues to track the bundled file,
-- so editing criteria.json and redeploying still works for anything untouched.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,   -- a Criteria field name
  value      TEXT NOT NULL,      -- JSON-encoded scalar or array
  updated_at TEXT NOT NULL
);

-- What the posting says about being in an office, as a fact rather than a
-- judgement. The remote policy caps on this, so the levels are decided in code
-- rather than trusted to the model.
ALTER TABLE scores ADD COLUMN attendance TEXT;
