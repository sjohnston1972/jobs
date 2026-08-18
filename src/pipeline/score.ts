import { callClaude, extractJson } from '../lib/claude';
import type {
  Attendance,
  Criteria,
  Ir35Signal,
  JobRow,
  RemoteConfidence,
  RemoteRequirement,
  ScoreResult,
  SeniorityFit,
} from '../lib/types';

/** Descriptions are capped so a 12,000-word public sector spec cannot blow the prompt out. */
const MAX_DESCRIPTION_CHARS = 9000;

/**
 * Rule 3 is selected by the configured level, and rule 1 quotes the configured
 * threshold. Both were literals until the threshold became adjustable, at which
 * point a prompt saying "60 is the threshold" while the digest used 40 would
 * have had the model scoring to a bar nobody was measuring against.
 */
const REMOTE_RULES: Record<RemoteRequirement, string> = {
  strict: `3. The candidate will only accept FULLY remote work. ANY stated
   requirement to attend an office or travel disqualifies — there is no
   threshold below which it becomes acceptable. Treat "98% remote",
   "mostly remote", "occasional travel" and "travel as required" as
   disqualifying, exactly as you would treat "hybrid".`,

  mostly: `3. The candidate accepts remote work with occasional travel, and
   rejects any fixed attendance pattern. "98% remote with occasional travel",
   "very occasional travel" and "travel as required" are ACCEPTABLE and should
   not cost significant points. "Hybrid", "2 days per week in the office",
   "3 days on site" and a named office given as the place of work are NOT
   acceptable and should score poorly.`,

  any: `3. Working location does not disqualify a posting. Note it and let it
   cost a few points where it is inconvenient, but judge the role primarily on
   its technical and seniority fit.`,
};

const ATTENDANCE_RULE = `4. Extract what the posting STATES about office attendance into
   \`attendance\`. This is a fact, not a judgement — report what the text says
   and nothing more:
     - "none"       fully remote, no attendance of any kind mentioned as required
     - "occasional" ad-hoc, rare or as-required travel; no fixed pattern
     - "fixed"      a recurring pattern — hybrid, N days per week, weekly on site
     - "onsite"     the work is based at a named location, remote not offered
     - "unstated"   the posting never addresses working location
   Use "unstated" when the text is silent. Do not infer "none" from silence.`;

export function buildSystemPrompt(criteria: Criteria): string {
  return `You assess UK job postings for one specific candidate and return JSON only.

Rules you must follow:

1. Score conservatively. Prefer a low score to a generous one. An inbox of false
   positives is worse than an empty digest. ${criteria.minScoreForDigest} is the threshold
   for "worth reading"; do not drift upward to be helpful.

2. The job board's own "remote" flag is unreliable and is not shown to you.
   Judge remoteness ONLY from wording in the description, and quote the exact
   phrase you relied on in remote_evidence. If nothing in the text addresses
   working location, remote_confidence is "low" and remote_evidence is null.

${REMOTE_RULES[criteria.remoteRequirement]}

${ATTENDANCE_RULE}

5. For contract postings, extract any IR35 statement into ir35_signal. The
   candidate intends to trade through a limited company, so "inside" is a red
   flag and should cost significant points. Use "n/a" for permanent roles and
   "unstated" when a contract posting is silent on it.

6. seniority_fit compares the posting's level to the candidate's. "below" means
   the posting is more junior than the candidate; that should cost points.

7. red_flags is a short array of specific concerns. Each entry is a terse
   label of at most six words, not a sentence and not an explanation —
   "inside IR35", "office attendance required", "salary below level",
   "12-month fixed term". The reasoning belongs in the reason field. Use an
   empty array when there are none, and do not invent concerns.

Output a single JSON object and nothing else. No prose, no markdown fences.`;
}

const SCHEMA_HINT = `{
  "score": 0,
  "remote_confidence": "high|medium|low",
  "remote_evidence": "the exact phrase in the posting that decided this, or \\"\\" if the posting never addresses working location",
  "ir35_signal": "inside|outside|unstated|n/a",
  "seniority_fit": "below|match|above",
  "attendance": "none|occasional|fixed|onsite|unstated",
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
    attendance: {
      type: 'string',
      enum: ['none', 'occasional', 'fixed', 'onsite', 'unstated'],
    },
    reason: { type: 'string' },
    red_flags: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'score', 'remote_confidence', 'remote_evidence',
    'ir35_signal', 'seniority_fit', 'attendance', 'reason', 'red_flags',
  ],
  additionalProperties: false,
} as const;

interface RawScore {
  score?: unknown;
  remote_confidence?: unknown;
  remote_evidence?: unknown;
  ir35_signal?: unknown;
  seniority_fit?: unknown;
  attendance?: unknown;
  reason?: unknown;
  red_flags?: unknown;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Rule 3 enforced in code rather than only asked for in the prompt. Models
 * drift on it — an early run scored a "98% remote, occasional travel to
 * London" role at 72 — so the level decides the cap here, from a fact the
 * model extracted rather than a judgement it made.
 *
 * `unstated` never caps at any level: a posting silent on working location is
 * the truncated-excerpt case the body gate defers here on purpose, and capping
 * it would reject genuinely remote roles on where an excerpt happened to end.
 */
export function capsScore(
  requirement: RemoteRequirement,
  attendance: Attendance | null,
): boolean {
  if (requirement === 'any') return false;
  if (attendance === null || attendance === 'none' || attendance === 'unstated') return false;
  if (requirement === 'strict') return true;
  return attendance === 'fixed' || attendance === 'onsite';
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
      system: buildSystemPrompt(criteria),
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
      attendance: null,
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
      attendance: null,
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

  const attendance = oneOf<Attendance>(parsed.attendance, [
    'none', 'occasional', 'fixed', 'onsite', 'unstated',
  ]);

  let finalScore = score;
  let reasonSuffix = '';
  if (score >= 40 && capsScore(criteria.remoteRequirement, attendance)) {
    finalScore = 39;
    reasonSuffix = ` [capped from ${score}: attendance is ${attendance}, requirement is ${criteria.remoteRequirement}]`;
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
    attendance,
    reason:
      (typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 400)
        : 'No reason returned.') + reasonSuffix,
    red_flags: flags,
    model,
  };
}
