import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseIndeedAlert } from '../src/sources/gmail/indeed';

const BODY = readFileSync(new URL('./fixtures/indeed-alert.txt', import.meta.url), 'utf8');
const WRAPPED = readFileSync(new URL('./fixtures/indeed-wrapped.txt', import.meta.url), 'utf8');
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
    expect(result.skippedNoKey).toBe(0);
  });
});

describe('parseIndeedAlert, awkward real-world blocks', () => {
  const parsed = () => parseIndeedAlert(WRAPPED, RECEIVED);

  it('accepts an uppercase job key rather than dropping it as an advert', () => {
    const [first] = parsed().postings;
    expect(first.sourceId).toBe('ABCDEF0123456789');
    expect(first.url).toBe('https://uk.indeed.com/viewjob?jk=ABCDEF0123456789');
  });

  it('counts a pagead slot and an unreadable organic key apart', () => {
    const result = parsed();
    // Folding these together would make a template change look like a rise in
    // advertising — the one thing skippedSponsored exists to rule out.
    expect(result.skippedSponsored).toBe(1);
    expect(result.skippedNoKey).toBe(1);
    expect(result.postings).toHaveLength(3);
  });

  it('rejoins a title hard-wrapped across two lines', () => {
    const [first] = parsed().postings;
    expect(first.title).toBe(
      'Senior Network Solutions Architect - Multi-Cloud Connectivity and Global WAN Transformation',
    );
  });

  it('keeps the employer and the location a wrapped title would have eaten', () => {
    // The damaging half: with the remainder read as the employer, the location
    // ends up null, the description loses its "Location: " prefix and the
    // scorer has nothing to say about working location.
    const [first] = parsed().postings;
    expect(first.employer).toBe('Acme Corp');
    expect(first.location).toBe('Remote');
  });

  it('does not treat an employer line as the tail of a long title', () => {
    const [, , third] = parsed().postings;
    expect(third.title).toBe(
      'Principal Infrastructure Architect for Regulated Financial Services',
    );
    expect(third.employer).toBe('Globex Consulting');
    expect(third.location).toBe('London');
  });

  it('reads an en-dash salary range the right way round', () => {
    const [first] = parsed().postings;
    expect(first.salaryMin).toBe(90000);
    expect(first.salaryMax).toBe(110000);
    expect(first.salaryPeriod).toBe('annual');
  });

  it('splits an en-dash employer and location', () => {
    const [first] = parsed().postings;
    expect(first.employer).toBe('Acme Corp');
    expect(first.location).toBe('Remote');
  });

  it('leaves the employer null when the block has no company line', () => {
    const [, second] = parsed().postings;
    expect(second.title).toBe('Cloud Network Engineer');
    expect(second.employer).toBeNull();
    expect(second.location).toBeNull();
    // The age line must still be read rather than consumed as the employer.
    expect(second.postedAt).toBe('2026-08-14T06:55:07.000Z');
    expect(second.snippet).toBe('');
  });

  it('does not let a long but genuine employer/location line absorb the snippet', () => {
    // "Public Sector Resourcing (PSR) - Manchester, Greater Manchester" is 63
    // characters — over the old WRAP_MIN of 60 despite never having wrapped.
    const body = [
      'Network Architect',
      'Public Sector Resourcing (PSR) - Manchester, Greater Manchester',
      'Design and operate the WAN estate for a public sector programme.',
      'Today',
      'https://uk.indeed.com/rc/clk/dl?jk=deadbeefcafebabe&from=ja&tk=SCRUBBED',
      '',
    ].join('\n');

    const [first] = parseIndeedAlert(body, RECEIVED).postings;
    expect(first.employer).toBe('Public Sector Resourcing (PSR)');
    expect(first.location).toBe('Manchester, Greater Manchester');
    expect(first.snippet).toBe('Design and operate the WAN estate for a public sector programme.');
  });
});
