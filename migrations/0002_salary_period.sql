-- Distinguishes day rates from annual salaries.
--
-- Reed and Adzuna both publish contract pay as a day rate and permanent pay as
-- an annual figure in the same salary_min/salary_max fields. Without a period,
-- a £600/day contract renders as "£600" in the digest and reads as a salary.
--
-- Apply with:
--   npx wrangler d1 execute job-monitor --remote --file=./migrations/0002_salary_period.sql

ALTER TABLE jobs ADD COLUMN salary_period TEXT DEFAULT 'unknown';

-- Backfill: nothing in this niche pays under £2,000 a year, so anything below
-- that threshold is a day rate.
UPDATE jobs SET salary_period =
  CASE
    WHEN COALESCE(salary_min, salary_max) IS NULL THEN 'unknown'
    WHEN COALESCE(salary_min, salary_max) < 2000  THEN 'daily'
    ELSE 'annual'
  END;
