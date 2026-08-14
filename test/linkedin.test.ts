import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLinkedInAlert } from '../src/sources/gmail/linkedin';

const BODY = readFileSync(new URL('./fixtures/linkedin-alert.txt', import.meta.url), 'utf8');
const WRAPPED = readFileSync(new URL('./fixtures/linkedin-wrapped.txt', import.meta.url), 'utf8');
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

describe('parseLinkedInAlert, awkward real-world blocks', () => {
  const parsed = () => parseLinkedInAlert(WRAPPED, RECEIVED);

  it('finds both postings when the rule between them is too short to split on', () => {
    // The rule length used to be load-bearing: only the first link in a block
    // was read, so the second posting vanished with no counter at all.
    const postings = parsed();
    expect(postings).toHaveLength(2);
    expect(postings.map((p) => p.sourceId)).toEqual(['4460000001', '4460000002']);
  });

  it('rejoins a title hard-wrapped across two lines', () => {
    const [first] = parsed();
    expect(first.title).toBe(
      'Senior Enterprise Solutions Architect for Global Network and Cloud Transformation',
    );
    expect(first.employer).toBe('HM Revenue & Customs');
    expect(first.location).toBe('United Kingdom');
  });

  it('follows a "View job" url that wrapped onto the next line', () => {
    const [, second] = parsed();
    expect(second.sourceId).toBe('4460000002');
    expect(second.url).toBe('https://www.linkedin.com/jobs/view/4460000002/');
    expect(second.title).toBe('Principal Network Architect');
    expect(second.employer).toBe('Ofgem');
    expect(second.location).toBe('England, United Kingdom');
  });

  it('finds two postings that share one paragraph with no blank line between', () => {
    const body = [
      'Your job alert for Europe',
      '',
      'Network Architect',
      'Ofgem',
      'England, United Kingdom',
      'View job: https://www.linkedin.com/comm/jobs/view/4470000001/?trackingId=X',
      '-----',
      'Security Architect',
      'UK Ministry of Defence',
      'Matlock',
      'View job: https://www.linkedin.com/comm/jobs/view/4470000002/?trackingId=X',
      '',
    ].join('\n');

    const postings = parseLinkedInAlert(body, RECEIVED);
    expect(postings.map((p) => [p.sourceId, p.title, p.employer, p.location])).toEqual([
      ['4470000001', 'Network Architect', 'Ofgem', 'England, United Kingdom'],
      ['4470000002', 'Security Architect', 'UK Ministry of Defence', 'Matlock'],
    ]);
  });

  it('does not swallow the employer line under a long title that never wrapped', () => {
    // 61 characters — over the old WRAP_MIN of 60 despite never having wrapped.
    // Ordinary length for a senior architecture title.
    const body = [
      'Your job alert for Europe',
      '',
      'Principal Cloud Architect for Public Sector Digital Programme',
      'HM Revenue & Customs',
      'United Kingdom',
      '',
      'View job: https://www.linkedin.com/comm/jobs/view/4480000001/?trackingId=SCRUBBED',
      '',
    ].join('\n');

    const [first] = parseLinkedInAlert(body, RECEIVED);
    expect(first.title).toBe('Principal Cloud Architect for Public Sector Digital Programme');
    expect(first.employer).toBe('HM Revenue & Customs');
    expect(first.location).toBe('United Kingdom');
  });
});
