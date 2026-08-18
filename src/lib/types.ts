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
  /** Google OAuth for the Gmail source. Read-only scope; see the design doc. */
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;

  // Plain vars
  SITE_URL: string;
  /** Cloudflare Access team domain, e.g. clydeford.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's AUD tag. Public identifier, not a secret. */
  ACCESS_AUD: string;
}

export type ContractType = 'permanent' | 'contract' | 'unknown';
export type RemoteConfidence = 'high' | 'medium' | 'low';
export type Ir35Signal = 'inside' | 'outside' | 'unstated' | 'n/a';
export type SeniorityFit = 'below' | 'match' | 'above';
/** How much office attendance the candidate will tolerate. Enforced in code, not just the prompt. */
export type RemoteRequirement = 'strict' | 'mostly' | 'any';
/** What the posting states about office attendance. A fact, not a judgement. */
export type Attendance = 'none' | 'occasional' | 'fixed' | 'onsite' | 'unstated';
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

/**
 * Sources whose alert emails carry no description. A posting with no text
 * about working location scores "low" remote confidence by scoring rule 2,
 * which scoreJob caps at 39 — below minScoreForDigest. Scoring them cannot
 * ever surface one; it only spends. They are collected as leads and are
 * reachable in the portal's leads view (`/?leads=1`). Do not remove this as
 * dead weight.
 *
 * Declared here rather than at any one use site because several unrelated
 * places need to agree on it: the prefilter drops them, getUnscoredJobs
 * excludes them in SQL so its LIMIT is not spent on rows that can never be
 * scored, dedupe refuses to let one suppress a board posting it can never
 * replace, and the portal decides from it whether a request is asking for
 * leads.
 */
export const UNSCORED_SOURCES: readonly string[] = ['linkedin'];

/** A posting after normalisation, before it reaches the database. */
export interface NormalisedJob {
  id: string; // "reed:40227781"
  source: 'reed' | 'adzuna' | 'indeed' | 'linkedin';
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
  attendance: Attendance | null;
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
  attendance: Attendance | null;
  reason: string | null;
  red_flags: string[];
  scored_at: string;
  status: ApplicationStatus | null;
  status_updated_at: string | null;
  notes: string | null;
}

/**
 * A row as the portal lists it. Identical to ScoredJob except that the score
 * and everything joined from it may be absent, because the portal's leads view
 * lists postings from UNSCORED_SOURCES that will never have a scores row.
 * ScoredJob is assignable to this, so the default (scored) view is unaffected.
 */
export interface PortalJob extends Omit<ScoredJob, 'score' | 'scored_at'> {
  score: number | null;
  scored_at: string | null;
  attendance: Attendance | null;
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
  /** Selects the rule 3 wording in the scoring prompt and the score cap policy. */
  remoteRequirement: RemoteRequirement;
  tailorThreshold: number;
  maxScoredPerRun: number;
  lookbackDays: number;
  contractTypes: string[];
  seedQueries: string[];
  /** Gmail search that selects the alert emails. Sender-based, so no Gmail-side filter is needed. */
  gmailQuery: string;
  /** Bounds the Gmail message fetches per run. */
  maxEmailsPerRun: number;
  /** Bounds how many email-sourced postings may reach the scorer in one run. */
  maxEmailJobsPerRun: number;
  scoringModel: string;
  tailoringModel: string;
}
