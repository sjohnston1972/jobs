import { describe, expect, it } from 'vitest';
import { summariseRejects } from '../src/pipeline/digest';
import type { ScoredJob } from '../src/lib/types';

function job(fields: Partial<ScoredJob>): ScoredJob {
  return {
    score: 30,
    remote_confidence: null,
    remote_evidence: null,
    ir35_signal: null,
    seniority_fit: null,
    attendance: null,
    reason: null,
    red_flags: [],
    ...fields,
  } as unknown as ScoredJob;
}

describe('summariseRejects', () => {
  it('does not count a posting silent on location as a remote reject, even under strict', () => {
    const jobs = [job({ attendance: 'unstated' })];
    // unstated never caps, at any level — see capsScore — so it should not
    // be reported as excluded on attendance even under strict.
    expect(summariseRejects(jobs, 'strict')).not.toContain('attendance');
  });

  it('does not count a posting with occasional travel as excluded under mostly', () => {
    const jobs = [job({ attendance: 'occasional' })];
    // capsScore('mostly', 'occasional') is false, so it falls through to
    // "other" rather than being reported as excluded on attendance.
    expect(summariseRejects(jobs, 'mostly')).not.toContain('attendance');
  });

  it('counts a posting with occasional travel as excluded under strict', () => {
    const jobs = [job({ attendance: 'occasional' })];
    expect(summariseRejects(jobs, 'strict')).toContain('1 excluded on attendance');
  });

  it('counts a fixed-pattern posting as excluded under mostly', () => {
    const jobs = [job({ attendance: 'fixed' })];
    expect(summariseRejects(jobs, 'mostly')).toContain('1 excluded on attendance');
  });

  it('never counts a NULL (legacy, pre-migration) attendance as a remote reject', () => {
    const jobs = [job({ attendance: null, seniority_fit: 'below' })];
    const summary = summariseRejects(jobs, 'strict');
    expect(summary).not.toContain('attendance');
    expect(summary).toContain('1 seniority below');
  });

  it('falls through to other reasons when nothing caps', () => {
    const jobs = [job({ seniority_fit: 'below' }), job({ ir35_signal: 'inside' }), job({ score: -1 })];
    const summary = summariseRejects(jobs, 'any');
    expect(summary).toContain('1 seniority below');
    expect(summary).toContain('1 inside IR35');
    expect(summary).toContain('1 scoring failed');
  });
});
