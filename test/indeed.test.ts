import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseIndeedAlert } from '../src/sources/gmail/indeed';

const BODY = readFileSync(new URL('./fixtures/indeed-alert.txt', import.meta.url), 'utf8');
const RECEIVED = new Date('2026-08-14T06:55:07Z');

describe('parseIndeedAlert', () => {
  it('extracts only postings carrying a jk key', () => {
    const result = parseIndeedAlert(BODY, RECEIVED);
    expect(result.postings).toHaveLength(3);
    expect(result.skippedSponsored).toBe(1);
  });

  it('reads title, employer and location from the first two lines', () => {
    const [first] = parseIndeedAlert(BODY, RECEIVED).postings;
    expect(first.title).toBe('Lead IT Network Administrator, Network, Voice, AV');
    expect(first.employer).toBe('KBR');
    expect(first.location).toBe('Leatherhead');
    expect(first.sourceId).toBe('5a8e508b1df985a6');
  });

  it('rebuilds a canonical url rather than keeping the tracking link', () => {
    const [first] = parseIndeedAlert(BODY, RECEIVED).postings;
    expect(first.url).toBe('https://uk.indeed.com/viewjob?jk=5a8e508b1df985a6');
  });

  it('takes the snippet and drops badge lines', () => {
    const [, second] = parseIndeedAlert(BODY, RECEIVED).postings;
    expect(second.snippet).toBe(
      'Relevant Professional Certifications: Microsoft Certified, VMware VCP, Cisco CCNA/CCNP',
    );
  });

  it('parses an annual salary range', () => {
    const [, second] = parseIndeedAlert(BODY, RECEIVED).postings;
    expect(second.salaryMin).toBe(63000);
    expect(second.salaryMax).toBe(67000);
    expect(second.salaryPeriod).toBe('annual');
  });

  it('parses a day rate as daily rather than an insulting salary', () => {
    const [, , third] = parseIndeedAlert(BODY, RECEIVED).postings;
    expect(third.salaryMin).toBe(600);
    expect(third.salaryMax).toBe(650);
    expect(third.salaryPeriod).toBe('daily');
  });

  it('leaves salary null when the posting states none', () => {
    const [first] = parseIndeedAlert(BODY, RECEIVED).postings;
    expect(first.salaryMin).toBeNull();
    expect(first.salaryPeriod).toBe('unknown');
  });

  it('resolves relative ages against the email date', () => {
    const [first, second, third] = parseIndeedAlert(BODY, RECEIVED).postings;
    expect(first.postedAt).toBe('2026-08-14T06:55:07.000Z'); // "Just posted"
    expect(second.postedAt).toBe('2026-08-12T06:55:07.000Z'); // "2 days ago"
    expect(third.postedAt).toBe('2026-08-14T06:55:07.000Z'); // "Today"
  });

  it('returns nothing for an email with no postings', () => {
    const result = parseIndeedAlert('Indeed Job Alert\n\nDo not share this email\n', RECEIVED);
    expect(result.postings).toEqual([]);
    expect(result.skippedSponsored).toBe(0);
  });
});
