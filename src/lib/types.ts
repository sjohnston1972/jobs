/**
 * Shared shapes. Every pipeline stage takes one of these and returns another,
 * so a stage can be replaced without touching its neighbours.
 */

export interface Env {
  DB: D1Database;

  // Secrets
  REED_API_KEY: string;
  ADZUNA_APP_ID: string;
  ADZUNA_APP_KEY: string;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY: string;
  TRACK_SIGNING_SECRET: string;
  DIGEST_TO: string;
  DIGEST_FROM: string;
  PORTAL_PASSWORD: string;

  // Plain vars
  SITE_URL: string;
}

export type ContractType = 'permanent' | 'contract' | 'unknown';
export type RemoteConfidence = 'high' | 'medium' | 'low';
export type Ir35Signal = 'inside' | 'outside' | 'unstated' | 'n/a';
export type SeniorityFit = 'below' | 'match' | 'above';
export type ApplicationStatus =
  | 'interested'
  | 'applied'
  | 'rejected'
  | 'interviewing'
  | 'closed';

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  'interested',
  'applied',
  'interviewing',
  'rejected',
  'closed',
];

/** A posting after normalisation, before it reaches the database. */
export interface NormalisedJob {
  id: string; // "reed:40227781"
  source: 'reed' | 'adzuna';
  source_id: string;
  title: string;
  employer: string | null;
  location_raw: string | null;
  remote_flag: number; // what the source claims. Not trusted.
  contract_type: ContractType;
  salary_min: number | null;
  salary_max: number | null;
  /** Boards put day rates and annual salaries in the same field. */
  salary_period: 'annual' | 'daily' | 'unknown';
  salary_predicted: number;
  currency: string | null;
  url: string;
  description: string;
  description_truncated: number;
  posted_at: string | null; // ISO
  content_hash: string;
  /** Title + salary only, so the same role from three agencies collapses. Null when no salary is stated. */
  role_hash: string | null;
}

/** A row as it comes back out of the jobs table. */
export interface JobRow extends NormalisedJob {
  first_seen_at: string;
}

export interface ScoreResult {
  score: number; // 0-100, or -1 when the model output could not be parsed
  remote_confidence: RemoteConfidence | null;
  remote_evidence: string | null;
  ir35_signal: Ir35Signal | null;
  seniority_fit: SeniorityFit | null;
  reason: string;
  red_flags: string[];
  model: string;
}

/** A job joined to its score and application status — what the UI and digest consume. */
export interface ScoredJob extends JobRow {
  score: number;
  remote_confidence: RemoteConfidence | null;
  remote_evidence: string | null;
  ir35_signal: Ir35Signal | null;
  seniority_fit: SeniorityFit | null;
  reason: string | null;
  red_flags: string[];
  scored_at: string;
  status: ApplicationStatus | null;
  status_updated_at: string | null;
  notes: string | null;
}

export interface RunCounts {
  fetched: number;
  new_jobs: number;
  prefiltered: number;
  scored: number;
  digested: number;
}

export interface Criteria {
  titleAllow: string[];
  titleBlock: string[];
  bodyRequireAny: string[];
  minScoreForDigest: number;
  tailorThreshold: number;
  maxScoredPerRun: number;
  lookbackDays: number;
  contractTypes: string[];
  seedQueries: string[];
  scoringModel: string;
  tailoringModel: string;
}
