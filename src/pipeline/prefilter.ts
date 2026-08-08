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
