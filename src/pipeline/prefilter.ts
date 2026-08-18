import type { Criteria } from '../lib/types';

export type RejectReason = 'title-not-allowed' | 'title-blocked' | 'no-remote-wording';

export interface Filterable {
  title: string;
  description: string | null;
  /** 1 when the stored text is a board excerpt rather than the full advert. */
  description_truncated: number;
}

export interface GateVerdict {
  pass: boolean;
  reason?: RejectReason;
  matched?: string;
}

/**
 * Gate 1: the title. Local, free, and the strongest single discriminator.
 * Runs before anything touches the network.
 */
export function titleGate(job: Filterable, criteria: Criteria): GateVerdict {
  const title = job.title.toLowerCase();

  const blocked = criteria.titleBlock.find((term) => title.includes(term.toLowerCase()));
  if (blocked) return { pass: false, reason: 'title-blocked', matched: blocked };

  const allowed = criteria.titleAllow.find((term) => title.includes(term.toLowerCase()));
  if (!allowed) return { pass: false, reason: 'title-not-allowed' };

  return { pass: true, matched: allowed };
}

/**
 * Gate 2: remote wording in the body.
 *
 * Only applied to text held in full. Board search endpoints return an excerpt,
 * and the remote statement usually sits below the cut — testing an excerpt for
 * "remote" rejects genuinely remote roles because of where a summary happened
 * to end. A truncated posting is therefore passed to the scorer, which judges
 * remoteness properly and marks it low confidence when the text does not say.
 */
export function bodyGate(job: Filterable, criteria: Criteria): GateVerdict {
  if (job.description_truncated) return { pass: true, matched: 'excerpt-deferred-to-scorer' };

  // The settings validator deliberately allows this list to be emptied (every
  // term removed one at a time through the portal). Array.find on an empty
  // list returns undefined just like "no term matched", so without this check
  // an emptied list would reject every full-text posting instead of imposing
  // no requirement at all.
  if (criteria.bodyRequireAny.length === 0) return { pass: true, matched: 'no-body-requirement' };

  const body = `${job.title} ${job.description ?? ''}`.toLowerCase();
  const remote = criteria.bodyRequireAny.find((term) => body.includes(term.toLowerCase()));
  if (!remote) return { pass: false, reason: 'no-remote-wording' };

  return { pass: true, matched: remote };
}

export interface PrefilterResult<T> {
  passed: T[];
  counts: Record<RejectReason, number>;
}

function runGate<T extends Filterable>(
  jobs: T[],
  criteria: Criteria,
  gate: (job: T, criteria: Criteria) => GateVerdict,
  counts: Record<RejectReason, number>,
): T[] {
  const passed: T[] = [];
  for (const job of jobs) {
    const verdict = gate(job, criteria);
    if (verdict.pass) passed.push(job);
    else counts[verdict.reason!]++;
  }
  return passed;
}

export function applyTitleGate<T extends Filterable>(
  jobs: T[],
  criteria: Criteria,
): PrefilterResult<T> {
  const counts: Record<RejectReason, number> = {
    'title-not-allowed': 0,
    'title-blocked': 0,
    'no-remote-wording': 0,
  };
  return { passed: runGate(jobs, criteria, titleGate, counts), counts };
}

/**
 * Gates leads at ingest, before they are ever stored.
 *
 * Scoreable postings (Reed, Adzuna, Indeed) are deliberately NOT gated here.
 * getUnscoredJobs reconsiders the stored backlog on every run, so widening
 * titleAllow later lets a previously-rejected board posting resurface from
 * storage — gating those at ingest would delete that second chance. A lead
 * from an unscored source has no second chance: it is never scored, so a
 * title that fails today fails forever, and a row that can only ever be
 * browsed, never scored, buys nothing by being stored anyway. Hence the
 * asymmetry: gate leads now, leave scoreable postings to the stage-4 gate.
 */
export function gateLeadsAtIngest<T extends Filterable & { source: string }>(
  jobs: T[],
  criteria: Criteria,
  unscoredSources: Set<string>,
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const job of jobs) {
    if (!unscoredSources.has(job.source)) {
      kept.push(job);
      continue;
    }
    if (titleGate(job, criteria).pass) kept.push(job);
    else dropped++;
  }
  return { kept, dropped };
}

export function applyBodyGate<T extends Filterable>(
  jobs: T[],
  criteria: Criteria,
): PrefilterResult<T> {
  const counts: Record<RejectReason, number> = {
    'title-not-allowed': 0,
    'title-blocked': 0,
    'no-remote-wording': 0,
  };
  return { passed: runGate(jobs, criteria, bodyGate, counts), counts };
}
