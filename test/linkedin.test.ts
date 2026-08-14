import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLinkedInAlert } from '../src/sources/gmail/linkedin';

const BODY = readFileSync(new URL('./fixtures/linkedin-alert.txt', import.meta.url), 'utf8');
const RECEIVED = new Date('2026-08-13T09:47:36Z');

describe('parseLinkedInAlert', () => {
  it('finds every posting and ignores the header and footer blocks', () => {
    expect(parseLinkedInAlert(BODY, RECEIVED)).toHaveLength(3);
  });

  it('does not mistake the alert header for the first posting', () => {
    const [first] = parseLinkedInAlert(BODY, RECEIVED);
    expect(first.title).toBe('Enterprise Technical Architect (Crown Hosting)');
    expect(first.employer).toBe('HM Revenue & Customs');
    expect(first.location).toBe('United Kingdom');
  });

  it('skips badge lines when more than one is present', () => {
    const [, second] = parseLinkedInAlert(BODY, RECEIVED);
    expect(second.title).toBe('CSOC Infrastructure - Assistant Head (AH) Strat Plans');
    expect(second.employer).toBe('UK Ministry of Defence');
    expect(second.location).toBe('Matlock');
  });

  it('handles a posting with no badge line at all', () => {
    const [, , third] = parseLinkedInAlert(BODY, RECEIVED);
    expect(third.title).toBe('Head of Data and AI Platforms');
    expect(third.employer).toBe('Ofgem');
    expect(third.location).toBe('England, United Kingdom');
  });

  it('takes the job id and rebuilds a canonical url', () => {
    const [first] = parseLinkedInAlert(BODY, RECEIVED);
    expect(first.sourceId).toBe('4449839863');
    expect(first.url).toBe('https://www.linkedin.com/jobs/view/4449839863/');
  });

  it('carries no salary and no snippet, which is why these are never scored', () => {
    const [first] = parseLinkedInAlert(BODY, RECEIVED);
    expect(first.salaryMin).toBeNull();
    expect(first.salaryMax).toBeNull();
    expect(first.salaryPeriod).toBe('unknown');
    expect(first.snippet).toBe('');
  });

  it('dates postings to the email, since the alert states no posting date', () => {
    const [first] = parseLinkedInAlert(BODY, RECEIVED);
    expect(first.postedAt).toBe('2026-08-13T09:47:36.000Z');
  });

  it('returns nothing for an email with no postings', () => {
    expect(parseLinkedInAlert('Your job alert for Europe\n\nNo new jobs.\n', RECEIVED)).toEqual([]);
  });
});
