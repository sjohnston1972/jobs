# Gmail Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect job postings from Indeed and LinkedIn alert emails in the Gmail inbox and feed them through the existing Job Monitor pipeline as a third source.

**Architecture:** A new `fetchGmail()` joins `fetchReed()` and `fetchAdzuna()` in stage 1 of `runPipeline` and returns `NormalisedJob[]`; nothing downstream changes shape. Authentication is a stored OAuth refresh token exchanged for an access token once per run. The two email parsers are pure functions from a plain-text body to posting objects, so they can be pinned against fixtures without a network or a token.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Gmail REST API v1, vitest (new to this repo).

**Spec:** `docs/superpowers/specs/2026-08-14-gmail-source-design.md` — read it before starting. It records why LinkedIn is never scored and why sponsored Indeed slots are dropped; both look like bugs if you meet them without the reasoning.

## Global Constraints

- Node 24, ESM only (`"type": "module"`). No CommonJS `require`.
- Workers runtime: **no Node built-ins**. No `Buffer`, no `node:*` imports in anything under `src/`. Use `atob` and `TextDecoder` for base64.
- `npm run typecheck` (`tsc --noEmit`, `strict: true`) must pass before every deploy.
- `tsconfig.json` `include` currently covers `src/**/*.ts` and `config/*.json` only. Task 1 adds `test/**/*.ts`.
- Test files import `describe`/`it`/`expect` explicitly from `vitest` — the tsconfig sets `"types": ["@cloudflare/workers-types"]`, so vitest globals are not available.
- Secrets `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` are **already created** on the Worker and present in `.env`. Do not re-run the auth script.
- OAuth scope is `gmail.readonly`. The Worker never writes, labels, or deletes mail.
- All money is GBP. Day rates and annual salaries share `salary_min`/`salary_max` and are distinguished by `salary_period` (`annual | daily | unknown`) — never add a new period value; convert instead.
- `BUILD` in `src/index.ts` is bumped by hand and reported by `/health`. Bump it in the final task.
- Deploys are not instant. Confirm `build` at `/health` in a browser (the endpoint is behind Cloudflare Access) before trusting any test run.

---

## File Structure

**Create:**
- `src/sources/gmail/types.ts` — `RawPosting`, `IndeedParseResult` shared by parsers and orchestrator
- `src/sources/gmail/indeed.ts` — `parseIndeedAlert()`, pure
- `src/sources/gmail/linkedin.ts` — `parseLinkedInAlert()`, pure
- `src/sources/gmail/client.ts` — OAuth + Gmail REST, the only file that touches the network
- `src/sources/gmail/index.ts` — `fetchGmail()`, maps `RawPosting` to `NormalisedJob`
- `test/fixtures/indeed-alert.txt`, `test/fixtures/linkedin-alert.txt`
- `test/indeed.test.ts`, `test/linkedin.test.ts`

**Modify:**
- `src/lib/types.ts` — widen `NormalisedJob['source']`; add Gmail secrets to `Env`; add three `Criteria` fields
- `config/criteria.json` — the three new values
- `src/index.ts` — stage 1 fetch, `UNSCORED_SOURCES`, email cap, `/gmail/preview`, `BUILD`
- `package.json`, `tsconfig.json` — vitest

**Not modified:** `src/web/portal.ts` and `src/lib/db.ts`. `getPortalJobs` already filters on `j.source = ?` for any value, and the portal renders `job.source` as a chip without a hardcoded list, so the new sources work with no change. The spec's line about "portal source filter gains the two new values" was wrong — nothing to do.

---

### Task 1: Test harness and the Indeed parser

The parser depends on a third party's email template. When Indeed changes it, the failure is silent — zero postings, no exception, a digest that just gets quieter. That is what these fixtures exist to catch.

**Files:**
- Create: `src/sources/gmail/types.ts`
- Create: `src/sources/gmail/indeed.ts`
- Create: `test/fixtures/indeed-alert.txt`
- Create: `test/indeed.test.ts`
- Modify: `package.json`, `tsconfig.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `RawPosting` — `{ source: 'indeed' | 'linkedin'; sourceId: string; title: string; employer: string | null; location: string | null; salaryMin: number | null; salaryMax: number | null; salaryPeriod: 'annual' | 'daily' | 'unknown'; snippet: string; url: string; postedAt: string | null }`
  - `IndeedParseResult` — `{ postings: RawPosting[]; skippedSponsored: number }`
  - `parseIndeedAlert(body: string, receivedAt: Date): IndeedParseResult`

- [ ] **Step 1: Install vitest and wire it up**

```bash
npm install -D vitest
```

Add to `package.json` `scripts` (keep the existing entries):

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

In `tsconfig.json`, change the `include` line to:

```json
  "include": ["src/**/*.ts", "config/*.json", "test/**/*.ts"],
```

- [ ] **Step 2: Write the fixture**

Create `test/fixtures/indeed-alert.txt` exactly as below. It is modelled on a real 2026-08-14 digest with tracking tokens scrubbed. It deliberately contains four posting blocks, one of which is a sponsored `pagead` slot with no `jk` key.

```
Indeed Job Alert
7 new Cisco jobs in London, Greater London

Jobs 1-7 of 7 new jobs
See matching results on Indeed: https://uk.indeed.com/jobs?q=Cisco&l=London

Lead IT Network Administrator, Network, Voice, AV
KBR - Leatherhead
Configure, administer, and optimize complex Cisco networking environments, including Cisco Identity Services Engine (ISE)
Just posted
https://uk.indeed.com/rc/clk/dl?jk=5a8e508b1df985a6&from=ja&tk=SCRUBBED

Senior IT Infrastructure Engineer
CSP Solutions - London
£63,000 - £67,000 a year
Easily apply
Relevant Professional Certifications: Microsoft Certified, VMware VCP, Cisco CCNA/CCNP
2 days ago
https://uk.indeed.com/rc/clk/dl?jk=1748df508575c323&from=ja&tk=SCRUBBED

Technical Services Engineer
IT Professional Services Ltd. - London
This is a sponsored placement carrying no job key.
9 days ago
https://uk.indeed.com/pagead/clk/dl?mo=r&ad=SCRUBBEDADTOKEN&rm=2

Network Architect
Acme Networks - Remote
£600 - £650 a day
Responsive employer
Easily apply
Outside IR35 contract for a fully remote network architect.
Today
https://uk.indeed.com/rc/clk/dl?jk=c83309d00e5cec14&from=ja&tk=SCRUBBED

Do not share this email
This email contains secure links that are personalised to you.

Salaries estimated if unavailable. When a job posting doesn't include a salary, we estimate it.
© 2026 Indeed Ireland Operations, Ltd.
```

- [ ] **Step 3: Write the failing test**

Create `test/indeed.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "../src/sources/gmail/indeed"`.

- [ ] **Step 5: Write the shared types**

Create `src/sources/gmail/types.ts`:

```ts
/** A posting as lifted out of an alert email, before it becomes a NormalisedJob. */
export interface RawPosting {
  source: 'indeed' | 'linkedin';
  sourceId: string;
  title: string;
  employer: string | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  /** Board day rates and annual salaries share two columns; this tells them apart. */
  salaryPeriod: 'annual' | 'daily' | 'unknown';
  snippet: string;
  url: string;
  postedAt: string | null; // ISO
}

export interface IndeedParseResult {
  postings: RawPosting[];
  /**
   * Blocks carrying a pagead link and no jk key. Roughly two thirds of an
   * Indeed digest measured on 2026-08-14, so this is the majority path — it is
   * counted rather than ignored so a further rise is visible in the logs.
   */
  skippedSponsored: number;
}
```

- [ ] **Step 6: Write the Indeed parser**

Create `src/sources/gmail/indeed.ts`:

```ts
import type { IndeedParseResult, RawPosting } from './types';

/** Everything after this line is legal boilerplate, not postings. */
const FOOTER = /^Do not share this email$/m;

/** A posting block is identified by its click-through link. */
const CLICK_URL = /https:\/\/uk\.indeed\.com\/(?:rc|pagead)\/clk[^\s]*/;

/** Organic results carry a 16-character hex job key; sponsored slots do not. */
const JOB_KEY = /[?&]jk=([0-9a-f]{6,})/;

/** e.g. "£63,000 - £67,000 a year", "£88,000 a year", "£600 - £650 a day" */
const SALARY =
  /£\s*([\d,]+(?:\.\d+)?)(?:\s*-\s*£\s*([\d,]+(?:\.\d+)?))?\s+(?:a|an|per)\s+(year|month|week|day|hour)/i;

/**
 * Badges Indeed sprinkles between the salary and the snippet. They appear
 * inconsistently, which is why lines are classified by pattern rather than
 * counted. An unrecognised badge falls through into the snippet, which is
 * harmless — the scorer reads prose.
 */
const BADGES = new Set([
  'easily apply',
  'responsive employer',
  'urgently hiring',
  'hiring multiple candidates',
  'new',
]);

const DAY_MS = 86_400_000;
/** The conventional annualisation used elsewhere in this codebase. */
const HOURS_PER_DAY = 7.5;

function parseSalary(line: string): Pick<RawPosting, 'salaryMin' | 'salaryMax' | 'salaryPeriod'> | null {
  const match = line.match(SALARY);
  if (!match) return null;

  const num = (raw: string | undefined) => (raw ? Number(raw.replace(/,/g, '')) : null);
  let min = num(match[1]);
  let max = num(match[2]);
  const unit = match[3].toLowerCase();

  // Everything collapses onto annual or daily so salary_period stays a
  // two-value question and no migration is needed.
  let period: 'annual' | 'daily' = 'annual';
  let factor = 1;
  if (unit === 'year') period = 'annual';
  else if (unit === 'month') factor = 12;
  else if (unit === 'week') factor = 52;
  else if (unit === 'day') period = 'daily';
  else if (unit === 'hour') {
    period = 'daily';
    factor = HOURS_PER_DAY;
  }

  if (min !== null) min = Math.round(min * factor);
  if (max !== null) max = Math.round(max * factor);
  return { salaryMin: min, salaryMax: max, salaryPeriod: period };
}

/**
 * "Just posted" and "Today" mean the email's own date; "N days ago" counts
 * back from it. Only called on lines isAgeLine has already accepted, so a
 * line with no digits is deliberately read as zero days.
 */
function parseAge(line: string, receivedAt: Date): string {
  const days = Number(line.match(/(\d+)\+?\s+days?\s+ago/i)?.[1] ?? 0);
  return new Date(receivedAt.getTime() - days * DAY_MS).toISOString();
}

function isAgeLine(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (!t) return false;
  return (
    t === 'just posted' ||
    t === 'today' ||
    t === 'posted today' ||
    /^\d+\+?\s+days?\s+ago$/.test(t) ||
    /^(?:employer\s+)?active\s+\d+\+?\s+days?\s+ago$/.test(t)
  );
}

export function parseIndeedAlert(body: string, receivedAt: Date): IndeedParseResult {
  const cut = body.search(FOOTER);
  const region = cut >= 0 ? body.slice(0, cut) : body;

  const postings: RawPosting[] = [];
  let skippedSponsored = 0;

  for (const block of region.split(/\n\s*\n/)) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const urlIndex = lines.findIndex((l) => CLICK_URL.test(l));
    // Header and footer blocks have no click-through and are not postings.
    if (urlIndex < 2) continue;

    const url = lines[urlIndex].match(CLICK_URL)![0];
    const key = url.match(JOB_KEY);
    if (!key) {
      skippedSponsored++;
      continue;
    }

    const title = lines[0];
    const [employer, location] = splitEmployerLocation(lines[1]);

    let salary: ReturnType<typeof parseSalary> = null;
    let postedAt: string | null = null;
    const snippetLines: string[] = [];

    for (const line of lines.slice(2, urlIndex)) {
      if (!salary) {
        const parsed = parseSalary(line);
        if (parsed) {
          salary = parsed;
          continue;
        }
      }
      if (isAgeLine(line)) {
        postedAt = parseAge(line, receivedAt);
        continue;
      }
      if (BADGES.has(line.toLowerCase())) continue;
      snippetLines.push(line);
    }

    postings.push({
      source: 'indeed',
      sourceId: key[1],
      title,
      employer,
      location,
      salaryMin: salary?.salaryMin ?? null,
      salaryMax: salary?.salaryMax ?? null,
      salaryPeriod: salary?.salaryPeriod ?? 'unknown',
      snippet: snippetLines.join(' '),
      // The tracking link is personalised and the email asks that it not be
      // shared; the canonical form is stable and safe to store.
      url: `https://uk.indeed.com/viewjob?jk=${key[1]}`,
      postedAt: postedAt ?? receivedAt.toISOString(),
    });
  }

  return { postings, skippedSponsored };
}

/** "KBR - Leatherhead". Employer names contain hyphens, so split on the last one. */
function splitEmployerLocation(line: string): [string | null, string | null] {
  const at = line.lastIndexOf(' - ');
  if (at < 0) return [line.trim() || null, null];
  return [line.slice(0, at).trim() || null, line.slice(at + 3).trim() || null];
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 9 tests in `test/indeed.test.ts`.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/sources/gmail test/
git commit -m "Add vitest and the Indeed alert parser"
```

---

### Task 2: The LinkedIn parser

LinkedIn alerts carry title, employer, location and a job id — no description and no salary. That is why they are never scored (Task 5); this task only lifts them out.

**Files:**
- Create: `src/sources/gmail/linkedin.ts`
- Create: `test/fixtures/linkedin-alert.txt`
- Create: `test/linkedin.test.ts`

**Interfaces:**
- Consumes: `RawPosting` from `src/sources/gmail/types.ts` (Task 1).
- Produces: `parseLinkedInAlert(body: string, receivedAt: Date): RawPosting[]`

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/linkedin-alert.txt`. Note the header paragraph before the first posting and the two different separator lengths — both are real, and both are traps for a naive parser.

```
Your job alert for Europe
New jobs match your preferences.

Enterprise Technical Architect (Crown Hosting)
HM Revenue & Customs
United Kingdom

1 company alum
View job: https://www.linkedin.com/comm/jobs/view/4449839863/?trackingId=SCRUBBED&refId=SCRUBBED

---------------------------------------------------------

CSOC Infrastructure - Assistant Head (AH) Strat Plans
UK Ministry of Defence
Matlock

This company is actively hiring
Apply with resume & profile
View job: https://www.linkedin.com/comm/jobs/view/4451684731/?trackingId=SCRUBBED

---------------------------------------------------------

Head of Data and AI Platforms
Ofgem
England, United Kingdom

View job: https://www.linkedin.com/comm/jobs/view/4442869099/?trackingId=SCRUBBED

---------------------------------------------------------

See all jobs on LinkedIn: https://www.linkedin.com/comm/jobs/search-results/?keywords=x

Job search smarter with Premium
https://www.linkedin.com/comm/premium/products/

----------------------------------------

This email was intended for Steven Johnston
Unsubscribe: https://www.linkedin.com/job-alert-email-unsubscribe?x=1
```

- [ ] **Step 2: Write the failing test**

Create `test/linkedin.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "../src/sources/gmail/linkedin"`.

- [ ] **Step 4: Write the LinkedIn parser**

Create `src/sources/gmail/linkedin.ts`:

```ts
import type { RawPosting } from './types';

/** Postings are separated by a rule; its length varies between sections. */
const RULE = /^-{10,}$/m;

const VIEW_JOB = /^View job:\s*(\S+)/;

/** e.g. https://www.linkedin.com/comm/jobs/view/4449839863/?trackingId=... */
const JOB_ID = /\/jobs\/view\/(\d+)/;

/**
 * Lines LinkedIn places between the location and the link. They must be
 * discarded before the title block is located, otherwise two badges look
 * exactly like a title and an employer.
 */
const BADGE =
  /^(?:\d+ company alum(?:ni)?|This company is actively hiring|Apply with resume & profile|Be an early applicant|Actively recruiting|Promoted|Easy Apply)$/i;

export function parseLinkedInAlert(body: string, receivedAt: Date): RawPosting[] {
  const postings: RawPosting[] = [];

  for (const block of body.split(RULE)) {
    // Paragraph groups, because the title/employer/location trio is its own
    // paragraph and the alert header is another — position alone would take
    // the header for the first posting.
    const groups = block
      .split(/\n\s*\n/)
      .map((g) => g.split('\n').map((l) => l.trim()).filter(Boolean))
      .filter((g) => g.length);

    const linkIndex = groups.findIndex((g) => g.some((l) => VIEW_JOB.test(l)));
    if (linkIndex < 0) continue; // "See all jobs", premium upsell, footer

    const linkGroup = groups[linkIndex];
    const linkLine = linkGroup.find((l) => VIEW_JOB.test(l))!;
    const id = linkLine.match(VIEW_JOB)![1].match(JOB_ID);
    if (!id) continue;

    // Usually the trio sits in the preceding group. When LinkedIn omits the
    // blank line it shares a group with the link, so prefer whatever real
    // content sits above the link once badges are removed.
    const sameGroup = linkGroup
      .slice(0, linkGroup.indexOf(linkLine))
      .filter((l) => !BADGE.test(l));
    const previous = (groups[linkIndex - 1] ?? []).filter((l) => !BADGE.test(l));
    const trio = sameGroup.length >= 2 ? sameGroup : previous;
    if (trio.length < 2) continue;

    postings.push({
      source: 'linkedin',
      sourceId: id[1],
      title: trio[0],
      employer: trio[1] ?? null,
      location: trio[2] ?? null,
      salaryMin: null,
      salaryMax: null,
      salaryPeriod: 'unknown',
      // LinkedIn alerts carry no description whatsoever. This is the reason
      // these postings are collected as leads and never sent to the scorer.
      snippet: '',
      url: `https://www.linkedin.com/jobs/view/${id[1]}/`,
      // The alert states no posting date, so the email's own date is the
      // best available and is at worst a day late.
      postedAt: receivedAt.toISOString(),
    });
  }

  return postings;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 17 tests across both files.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/sources/gmail/linkedin.ts test/
git commit -m "Add the LinkedIn alert parser"
```

---

### Task 3: The Gmail API client

The only file in this feature that touches the network. Runs in the Workers runtime, so no `Buffer` and no `node:*`.

**Files:**
- Create: `src/sources/gmail/client.ts`
- Modify: `src/lib/types.ts` (the `Env` interface only)

**Interfaces:**
- Consumes: `Env` from `src/lib/types.ts`.
- Produces:
  - `GmailMessage` — `{ id: string; from: string; subject: string; receivedAt: Date; plainText: string | null }`
  - `getAccessToken(env: Env): Promise<string>`
  - `listMessageIds(token: string, query: string, max: number): Promise<string[]>`
  - `getMessage(token: string, id: string): Promise<GmailMessage>`

- [ ] **Step 1: Add the secrets to `Env`**

In `src/lib/types.ts`, inside the `Env` interface, after the `DIGEST_FROM: string;` line and before the `// Plain vars` comment, add:

```ts
  /** Google OAuth for the Gmail source. Read-only scope; see the design doc. */
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
```

- [ ] **Step 2: Write the client**

Create `src/sources/gmail/client.ts`:

```ts
import type { Env } from '../../lib/types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  plainText: string | null;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

/**
 * Access tokens last an hour and a run takes seconds, so this is called once
 * per run and nothing is cached between them.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    // A revoked token or an OAuth app left in "Testing" both land here.
    throw new Error(`Gmail token — HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Gmail token — response carried no access_token');
  return data.access_token;
}

async function api<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API}/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Gmail ${path} — HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

export async function listMessageIds(token: string, query: string, max: number): Promise<string[]> {
  const data = await api<{ messages?: { id: string }[] }>(
    token,
    `messages?maxResults=${max}&q=${encodeURIComponent(query)}`,
  );
  return (data.messages ?? []).map((m) => m.id);
}

/** No Buffer in the Workers runtime, and the bodies contain £ signs, so the
 *  bytes must go through TextDecoder rather than being read as latin1. */
function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Alert emails are multipart; the plain text part is far easier to parse than
 *  the HTML, so it is the only part this reads. */
function plainTextPart(part: GmailPart): string | null {
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const found = plainTextPart(child);
    if (found) return found;
  }
  return null;
}

export async function getMessage(token: string, id: string): Promise<GmailMessage> {
  const msg = await api<{ payload: GmailPart; internalDate?: string }>(
    token,
    `messages/${id}?format=full`,
  );
  const header = (name: string) =>
    msg.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';

  const dateHeader = header('date');
  const parsed = dateHeader ? Date.parse(dateHeader) : NaN;
  const receivedAt = Number.isNaN(parsed)
    ? new Date(Number(msg.internalDate ?? Date.now()))
    : new Date(parsed);

  return {
    id,
    from: header('from'),
    subject: header('subject'),
    receivedAt,
    plainText: plainTextPart(msg.payload),
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0. There are no unit tests here — it is all network I/O, and it gets exercised for real by `/gmail/preview` in Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/sources/gmail/client.ts
git commit -m "Add the Gmail API client"
```

---

### Task 4: fetchGmail — dispatch and normalise

Turns `RawPosting` objects into `NormalisedJob` objects so the rest of the pipeline cannot tell an email posting from a board one.

**Files:**
- Create: `src/sources/gmail/index.ts`
- Modify: `src/lib/types.ts` (`NormalisedJob['source']` and `Criteria`)
- Modify: `config/criteria.json`

**Interfaces:**
- Consumes: `parseIndeedAlert` (Task 1), `parseLinkedInAlert` (Task 2), `getAccessToken`/`listMessageIds`/`getMessage` (Task 3).
- Produces: `fetchGmail(env: Env, criteria: Criteria, queryOverride?: string): Promise<NormalisedJob[]>`

- [ ] **Step 1: Widen the source union and the criteria**

In `src/lib/types.ts`, change the `source` line inside `NormalisedJob`:

```ts
  source: 'reed' | 'adzuna' | 'indeed' | 'linkedin';
```

And add to the `Criteria` interface, after `seedQueries: string[];`:

```ts
  /** Gmail search that selects the alert emails. Sender-based, so no Gmail-side filter is needed. */
  gmailQuery: string;
  /** Bounds the Gmail message fetches per run. */
  maxEmailsPerRun: number;
  /** Bounds how many email-sourced postings may reach the scorer in one run. */
  maxEmailJobsPerRun: number;
```

- [ ] **Step 2: Add the values to `config/criteria.json`**

Insert after the `"seedQueries": [...]` array and before `"scoringModel"`:

```json
  "gmailQuery": "newer_than:2d from:(donotreply@jobalert.indeed.com OR jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com)",
  "maxEmailsPerRun": 40,
  "maxEmailJobsPerRun": 15,
```

- [ ] **Step 3: Write the orchestrator**

Create `src/sources/gmail/index.ts`:

```ts
import type { Criteria, Env, NormalisedJob } from '../../lib/types';
import { inferContractType, looksRemote, withHash } from '../../pipeline/normalise';
import { getAccessToken, getMessage, listMessageIds } from './client';
import { parseIndeedAlert } from './indeed';
import { parseLinkedInAlert } from './linkedin';
import type { RawPosting } from './types';

/**
 * Job alert emails as a third source.
 *
 * Indeed and LinkedIn have no usable public API, so their alert mail is the
 * only practical route in. Both are read from the text/plain part, which is
 * rigidly structured and far cheaper to parse than the HTML.
 *
 * queryOverride exists for /gmail/preview, which widens the window to inspect
 * what the parsers make of the last few days.
 */
export async function fetchGmail(
  env: Env,
  criteria: Criteria,
  queryOverride?: string,
): Promise<NormalisedJob[]> {
  const token = await getAccessToken(env);
  const query = queryOverride ?? criteria.gmailQuery;
  const ids = await listMessageIds(token, query, criteria.maxEmailsPerRun);

  const postings: RawPosting[] = [];
  let sponsored = 0;
  let indeedMails = 0;
  let linkedinMails = 0;
  let unparsed = 0;

  for (const id of ids) {
    const message = await getMessage(token, id);
    if (!message.plainText) {
      unparsed++;
      continue;
    }
    const from = message.from.toLowerCase();

    if (from.includes('jobalert.indeed.com')) {
      indeedMails++;
      const result = parseIndeedAlert(message.plainText, message.receivedAt);
      postings.push(...result.postings);
      sponsored += result.skippedSponsored;
    } else if (from.includes('linkedin.com')) {
      linkedinMails++;
      postings.push(...parseLinkedInAlert(message.plainText, message.receivedAt));
    }
    // Anything else matched the query but has no parser; ignored silently.
  }

  console.log(
    'gmail: ' +
      `${ids.length} messages (${indeedMails} indeed, ${linkedinMails} linkedin), ` +
      `${postings.length} postings, ${sponsored} sponsored skipped, ${unparsed} without a text part`,
  );

  return Promise.all(postings.map(toNormalisedJob));
}

function toNormalisedJob(posting: RawPosting): Promise<NormalisedJob> {
  // The location is prepended because Indeed frequently writes "Remote" or
  // "Hybrid remote in London" there, and it is the only text in the email that
  // addresses working location for the scorer to quote as remote_evidence.
  const description = [
    posting.location ? `Location: ${posting.location}` : '',
    posting.snippet,
  ]
    .filter(Boolean)
    .join('\n');

  return withHash({
    id: `${posting.source}:${posting.sourceId}`,
    source: posting.source,
    source_id: posting.sourceId,
    title: posting.title,
    employer: posting.employer,
    location_raw: posting.location,
    remote_flag: looksRemote(posting.title, description),
    contract_type: inferContractType(`${posting.title} ${posting.snippet}`),
    salary_min: posting.salaryMin,
    salary_max: posting.salaryMax,
    salary_period: posting.salaryPeriod,
    // Indeed estimates a salary when the employer states none and does not say
    // which is which, so every figure from it is treated as predicted.
    salary_predicted: posting.source === 'indeed' && posting.salaryMin !== null ? 1 : 0,
    currency: posting.salaryMin !== null ? 'GBP' : null,
    url: posting.url,
    description,
    // An alert excerpt is never the whole advert, so the body gate defers it to
    // the scorer exactly as it does for Adzuna.
    description_truncated: 1,
    posted_at: posting.postedAt,
  });
}
```

- [ ] **Step 4: Typecheck and commit**

Run: `npm run typecheck`
Expected: no output, exit 0.

```bash
git add src/lib/types.ts config/criteria.json src/sources/gmail/index.ts
git commit -m "Add fetchGmail and widen the source union"
```

---

### Task 5: Wire into the pipeline

**Files:**
- Modify: `src/index.ts` (imports, stage 1, stage 4)

**Interfaces:**
- Consumes: `fetchGmail` (Task 4).
- Produces: no new exports. `UNSCORED_SOURCES` and `EMAIL_SOURCES` are module-private constants.

- [ ] **Step 1: Import fetchGmail**

In `src/index.ts`, after the line `import { fetchReed, fetchReedDescription } from './sources/reed';`, add:

```ts
import { fetchGmail } from './sources/gmail';
```

- [ ] **Step 2: Add the two source sets**

After the existing `const MAX_ENRICH_PER_RUN = 60;` line, add:

```ts
/**
 * Sources whose alert emails carry no description. A posting with no text
 * about working location scores "low" remote confidence by scoring rule 2,
 * which scoreJob caps at 39 — below minScoreForDigest. Scoring them cannot
 * ever surface one; it only spends. They are collected as leads for the
 * portal instead. Do not remove this as dead weight.
 */
const UNSCORED_SOURCES = new Set(['linkedin']);

/** Email-sourced postings share a budget of their own; see below. */
const EMAIL_SOURCES = new Set(['indeed', 'linkedin']);
```

- [ ] **Step 3: Fetch from Gmail in stage 1**

In `runPipeline`, immediately after the `for (const query of criteria.seedQueries) { ... }` loop closes and before `counts.fetched = collected.length;`, add:

```ts
  // Alert emails, once per run rather than once per seed query.
  try {
    collected.push(...(await fetchGmail(env, criteria)));
  } catch (err) {
    errors.push(`gmail: ${String(err)}`);
  }
```

- [ ] **Step 4: Exclude unscored sources before the title gate**

In stage 4, replace this line:

```ts
    const titled = applyTitleGate(unscored, criteria);
```

with:

```ts
    // Dropped before the gates rather than after, so they cost nothing.
    const scoreableSources = unscored.filter((j) => !UNSCORED_SOURCES.has(j.source));
    const titled = applyTitleGate(scoreableSources, criteria);
```

- [ ] **Step 5: Apply the email budget before the global one**

Replace this line:

```ts
    toScore = bodied.passed.slice(0, criteria.maxScoredPerRun);
```

with:

```ts
    // Email postings get a budget of their own before the global cap, or one
    // noisy Indeed morning consumes the whole scoring allowance and crowds out
    // Reed and Adzuna. Boards come first because they carry full descriptions
    // and score better; anything squeezed out is not lost, since getUnscoredJobs
    // reconsiders the backlog on the next run.
    const boardJobs = bodied.passed.filter((j) => !EMAIL_SOURCES.has(j.source));
    const emailJobs = bodied.passed
      .filter((j) => EMAIL_SOURCES.has(j.source))
      .slice(0, criteria.maxEmailJobsPerRun);
    toScore = [...boardJobs, ...emailJobs].slice(0, criteria.maxScoredPerRun);
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Verify the parsers still pass**

Run: `npm test`
Expected: PASS, 17 tests.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "Feed Gmail postings into the pipeline with their own scoring budget"
```

---

### Task 6: /gmail/preview, build marker, deploy and verify

`/gmail/preview` is how the parser gets checked the morning after Indeed changes its template. It reads and renders; it never inserts.

**Files:**
- Modify: `src/index.ts` (`BUILD`, the new route)

**Interfaces:**
- Consumes: `fetchGmail` (Task 4, imported by Task 5), `layout` from `./web/portal` and `escapeHtml` from `./pipeline/digest`.
- Produces: `GET /gmail/preview?days=N`, behind Cloudflare Access.

Place the route anywhere after the `const viewer = await signedInEmail(...)` line and before the `if (path === '/')` portal route — it needs `viewer` in scope.

- [ ] **Step 1: Bump the build marker**

In `src/index.ts`, change:

```ts
export const BUILD = 'v9-chip-overflow';
```

to:

```ts
export const BUILD = 'v10-gmail-source';
```

- [ ] **Step 2: Add the route**

In the `fetch` handler, after the `if (path === '/weekly') { ... }` block and before the `// ---- portal` comment, add:

```ts
      // Renders what the alert parsers make of recent mail without inserting
      // anything. The check to run when a parser has gone quiet.
      if (path === '/gmail/preview') {
        if (!viewer) return json({ error: 'not authorised' }, 403);
        const days = Number(url.searchParams.get('days') ?? 2);
        const window = Number.isFinite(days) && days > 0 ? Math.floor(days) : 2;
        const query = criteria.gmailQuery.replace(/newer_than:\d+d/, `newer_than:${window}d`);

        const jobs = await fetchGmail(env, criteria, query);
        const rows = jobs
          .map(
            (j) => `<tr>
              <td>${escapeHtml(j.source)}</td>
              <td><a href="${escapeHtml(j.url)}">${escapeHtml(j.title)}</a></td>
              <td>${escapeHtml(j.employer ?? '—')}</td>
              <td>${escapeHtml(j.location_raw ?? '—')}</td>
              <td>${j.salary_min ?? '—'}${j.salary_max ? `–${j.salary_max}` : ''} ${escapeHtml(j.salary_period)}</td>
              <td>${escapeHtml((j.description ?? '').slice(0, 160))}</td>
            </tr>`,
          )
          .join('');

        return html(
          layout(
            'Gmail preview — Job Monitor',
            `<div class="prose">
               <h1>Gmail preview</h1>
               <p style="color:var(--dim)">${jobs.length} postings parsed from the last
                 ${window} day(s). Nothing was written to the database.</p>
               <p style="color:var(--dim)"><code>${escapeHtml(query)}</code></p>
               <table style="width:100%;border-collapse:collapse;font-size:13px">
                 <tr style="text-align:left">
                   <th>source</th><th>title</th><th>employer</th>
                   <th>location</th><th>salary</th><th>description</th>
                 </tr>
                 ${rows || '<tr><td colspan="6">Nothing parsed.</td></tr>'}
               </table>
             </div>`,
          ),
        );
      }
```

- [ ] **Step 3: Import escapeHtml**

`escapeHtml` is already exported from `src/pipeline/digest.ts` — `src/web/portal.ts` imports it from there. Nothing needs exporting. Add it to the existing digest import in `src/index.ts`, changing:

```ts
import { buildDigest, buildWeeklySummary } from './pipeline/digest';
```

to:

```ts
import { buildDigest, buildWeeklySummary, escapeHtml } from './pipeline/digest';
```

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 5: Commit and deploy**

```bash
git add src/index.ts
git commit -m "Add /gmail/preview and bump the build marker"
npm run deploy
```

- [ ] **Step 6: Confirm the deploy is actually live**

Open `https://jobs.foundry-ns.com/health` in a browser (Access blocks unauthenticated curl) and confirm `"build": "v10-gmail-source"`.

Do not proceed until it reads v10. A run against the previous version produces confusing results — this has already cost this project two debugging sessions.

- [ ] **Step 7: Verify against real mail**

Open `https://jobs.foundry-ns.com/gmail/preview?days=3`.

Expected: a table of postings. Check specifically that
- Indeed rows carry a plausible employer, location and salary
- LinkedIn rows appear with `—` for salary and a `Location:` description
- no row has a title that looks like an alert header ("Your job alert for Europe")
- titles are not truncated mid-word or shifted by one line

If a column is systematically wrong, the parser needs a fixture that reproduces it — add the case to `test/fixtures/` and fix under test rather than by inspection.

- [ ] **Step 8: Run the pipeline once and read the log**

Open `https://jobs.foundry-ns.com/run`, then:

```bash
npx wrangler tail
```

Expected in the log: a `gmail: N messages (...) M postings, S sponsored skipped` line, then the usual `dedupe:` and `prefilter:` lines with the totals raised. Confirm `errors` is empty in the `run complete` line.

- [ ] **Step 9: Confirm the new sources reached the database**

```bash
npx wrangler d1 execute job-monitor --remote --command "SELECT source, COUNT(*) FROM jobs GROUP BY source"
```

Expected: rows for `reed`, `adzuna`, `indeed` and `linkedin`.

- [ ] **Step 10: Confirm LinkedIn postings were never scored**

```bash
npx wrangler d1 execute job-monitor --remote --command "SELECT COUNT(*) FROM jobs j JOIN scores s ON s.job_id = j.id WHERE j.source = 'linkedin'"
```

Expected: `0`. Anything above zero means the `UNSCORED_SOURCES` filter is in the wrong place and is costing money for scores that can never clear the threshold.

- [ ] **Step 11: Final commit**

```bash
git add -A
git commit -m "Gmail source verified against live mail"
```

---

## Known limitations, recorded deliberately

- **LinkedIn postings stay unscored forever** and therefore keep reappearing in `getUnscoredJobs` until they age past `lookbackDays + 3`. That query has a limit of 500, so a heavy LinkedIn week consumes some of that headroom. Harmless at current volumes (roughly 15 a day against a 500 limit) and cheap to filter, but if the backlog ever crowds out genuine unscored jobs the fix is to write a marker row into `scores` rather than to start scoring them.
- **Sponsored Indeed slots are dropped, and they are the majority** — 24 of 38 links on 2026-08-14. Expected yield is about a third of the raw link count.
- **No enrichment for email postings.** They stay `description_truncated = 1` and are judged by the scorer on an excerpt plus the location line. Fetching the canonical page was considered and deferred; LinkedIn and Indeed block Workers often enough to need its own spike.
