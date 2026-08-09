import { callClaude, extractJson } from '../lib/claude';
import type {
  Criteria,
  Ir35Signal,
  JobRow,
  RemoteConfidence,
  ScoreResult,
  SeniorityFit,
} from '../lib/types';

/** Descriptions are capped so a 12,000-word public sector spec cannot blow the prompt out. */
const MAX_DESCRIPTION_CHARS = 9000;

const SYSTEM_PROMPT = `You assess UK job postings for one specific candidate and return JSON only.

Rules you must follow:

1. Score conservatively. Prefer a low score to a generous one. An inbox of false
   positives is worse than an empty digest. 60 is the threshold for "worth
   reading"; do not drift upward to be helpful.

2. The job board's own "remote" flag is unreliable and is not shown to you.
   Judge remoteness ONLY from wording in the description, and quote the exact
   phrase you relied on in remote_evidence. If nothing in the text addresses
   working location, remote_confidence is "low" and remote_evidence is null.

3. The candidate will only accept FULLY remote work. remote_confidence is
   "high" ONLY when the posting states remote working with no attendance
   requirement of any kind. ANY stated requirement to attend an office or
   travel makes it "low" — there is no threshold below which it becomes
   acceptable. Treat all of these as "low":
     - "hybrid", "2 days per week in the office", "3 days on site"
     - "98% remote", "mostly remote", "predominantly remote"
     - "occasional travel", "very occasional travel", "rare travel",
       "travel as required", "attendance for quarterly planning"
     - a named office location given as a place of work
   Use "medium" only when the posting says remote but is genuinely ambiguous
   about attendance, never when attendance is mentioned. A "low" posting MUST
   score below 40 however good the role is otherwise.

4. For contract postings, extract any IR35 statement into ir35_signal. The
   candidate intends to trade through a limited company, so "inside" is a red
   flag and should cost significant points. Use "n/a" for permanent roles and
   "unstated" when a contract posting is silent on it.

5. seniority_fit compares the posting's level to the candidate's. "below" means
   the posting is more junior than the candidate; that should cost points.

6. red_flags is a short array of specific concerns. Each entry is a terse
   label of at most six words, not a sentence and not an explanation —
   "inside IR35", "office attendance required", "salary below level",
   "12-month fixed term". The reasoning belongs in `reason`. Use an empty
   array when there are none, and do not invent concerns.

Output a single JSON object and nothing else. No prose, no markdown fences.`;

const SCHEMA_HINT = `{
  "score": 0,
  "remote_confidence": "high|medium|low",
  "remote_evidence": "the exact phrase in the posting that decided this, or \\"\\" if the posting never addresses working location",
  "ir35_signal": "inside|outside|unstated|n/a",
  "seniority_fit": "below|match|above",
  "reason": "one sentence, under 25 words, specific to this posting",
  "red_flags": []
}`;

/**
 * Enforced by the API rather than requested in prose, so the response cannot
 * arrive as prose, as a fenced block, or with a missing field.
 */
const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    remote_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    remote_evidence: { type: 'string' },
    ir35_signal: { type: 'string', enum: ['inside', 'outside', 'unstated', 'n/a'] },
    seniority_fit: { type: 'string', enum: ['below', 'match', 'above'] },
    reason: { type: 'string' },
    red_flags: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'score', 'remote_confidence', 'remote_evidence',
    'ir35_signal', 'seniority_fit', 'reason', 'red_flags',
  ],
  additionalProperties: false,
} as const;

interface RawScore {
  score?: unknown;
  remote_confidence?: unknown;
  remote_evidence?: unknown;
  ir35_signal?: unknown;
  seniority_fit?: unknown;
  reason?: unknown;
  red_flags?: unknown;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

export function buildScoringPrompt(job: JobRow, profile: string): string {
  const description = (job.description ?? '').slice(0, MAX_DESCRIPTION_CHARS);
  const truncationNote = job.description_truncated
    ? '\nNOTE: this description is an excerpt from the job board, not the full advert. ' +
      'Where it is silent on a point, treat that as unstated rather than absent, but do ' +
      'not infer remote working from silence.'
    : '';

  const period =
    job.salary_period === 'daily' ? ' per day' : job.salary_period === 'annual' ? ' per year' : '';
  const salary =
    job.salary_min || job.salary_max
      ? `${job.salary_min ?? '?'} to ${job.salary_max ?? '?'} ${job.currency ?? 'GBP'}${period}` +
        (job.salary_predicted ? ' (ESTIMATED by the job board, not stated by the employer)' : ' (stated)')
      : 'not stated';

  return `<candidate_profile>
${profile}
</candidate_profile>

<posting>
Title: ${job.title}
Employer: ${job.employer ?? 'not stated'}
Location as advertised: ${job.location_raw ?? 'not stated'}
Contract type as advertised: ${job.contract_type}
Salary: ${salary}
Posted: ${job.posted_at ?? 'unknown'}

Description:
${description}
</posting>${truncationNote}

Assess this posting against the candidate profile and return JSON matching exactly this shape:

${SCHEMA_HINT}`;
}

/**
 * One call per job. Parsing is defensive: a failure is stored as score -1 with
 * the raw text in `reason`, so a broken scorer is visible in the portal instead
 * of quietly emptying the digest.
 */
export async function scoreJob(
  apiKey: string,
  job: JobRow,
  profile: string,
  criteria: Criteria,
): Promise<ScoreResult> {
  const model = criteria.scoringModel;

  let raw: string;
  try {
    raw = await callClaude(apiKey, {
      model,
      system: SYSTEM_PROMPT,
      prompt: buildScoringPrompt(job, profile),
      maxTokens: 600,
      temperature: 0,
      jsonSchema: SCORE_SCHEMA as unknown as Record<string, unknown>,
    });
  } catch (err) {
    return {
      score: -1,
      remote_confidence: null,
      remote_evidence: null,
      ir35_signal: null,
      seniority_fit: null,
      reason: `SCORING FAILED: ${String(err).slice(0, 400)}`,
      red_flags: [],
      model,
    };
  }

  const parsed = extractJson<RawScore>(raw);
  if (!parsed || typeof parsed !== 'object') {
    return {
      score: -1,
      remote_confidence: null,
      remote_evidence: null,
      ir35_signal: null,
      seniority_fit: null,
      reason: `UNPARSEABLE MODEL OUTPUT: ${raw.slice(0, 400)}`,
      red_flags: [],
      model,
    };
  }

  const scoreNumber = Number(parsed.score);
  const score = Number.isFinite(scoreNumber)
    ? Math.max(0, Math.min(100, Math.round(scoreNumber)))
    : -1;

  const flags = Array.isArray(parsed.red_flags)
    ? parsed.red_flags.map((f) => String(f)).filter(Boolean).slice(0, 8)
    : [];

  const confidence = oneOf<RemoteConfidence>(parsed.remote_confidence, ['high', 'medium', 'low']);

  // Rule 3 is enforced here rather than only asked for in the prompt. Models
  // drift on it — an early run scored a "98% remote, occasional travel to
  // London" role at 72 — and "fully remote only" is the one requirement that
  // is not a matter of degree.
  let finalScore = score;
  let reasonSuffix = '';
  if (confidence === 'low' && finalScore >= 40) {
    finalScore = 39;
    reasonSuffix = ` [capped from ${score}: remote confidence is low]`;
  }

  return {
    score: finalScore,
    remote_confidence: confidence,
    remote_evidence:
      typeof parsed.remote_evidence === 'string' && parsed.remote_evidence.trim()
        ? parsed.remote_evidence.trim().slice(0, 500)
        : null,
    ir35_signal: oneOf<Ir35Signal>(parsed.ir35_signal, ['inside', 'outside', 'unstated', 'n/a']),
    seniority_fit: oneOf<SeniorityFit>(parsed.seniority_fit, ['below', 'match', 'above']),
    reason:
      (typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 400)
        : 'No reason returned.') + reasonSuffix,
    red_flags: flags,
    model,
  };
}
