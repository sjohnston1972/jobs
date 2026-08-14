import type { IndeedParseResult, RawPosting } from './types';
import { joinWrappedLines } from './wrap';

/** Everything after this line is legal boilerplate, not postings. */
const FOOTER = /^Do not share this email$/m;

/** A posting block is identified by its click-through link. */
const CLICK_URL = /https:\/\/uk\.indeed\.com\/(?:rc|pagead)\/clk[^\s]*/;

/**
 * Organic results carry a hex job key; sponsored slots do not. Case-insensitive
 * because Indeed does not guarantee the case of the key, and a key rejected
 * here is not merely lost — it would also be counted as an advertisement, which
 * is the one counter meant to reveal that this parser has stopped working.
 */
const JOB_KEY = /[?&]jk=([0-9a-fA-F]{6,})/;

/**
 * e.g. "£63,000 - £67,000 a year", "£88,000 a year", "£600 - £650 a day".
 * The separator may be a hyphen or an en/em dash; with only the hyphen
 * accepted, "£90,000 – £110,000 a year" matched from the upper figure onwards
 * and recorded £110,000 as the floor.
 */
const SALARY =
  /£\s*([\d,]+(?:\.\d+)?)(?:\s*[-–—]\s*£\s*([\d,]+(?:\.\d+)?))?\s+(?:a|an|per)\s+(year|month|week|day|hour)/i;

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
/**
 * Hours in a working day, assumed here so an hourly rate can be expressed as a
 * daily one — salary_period has no hourly value. This is an assumption
 * introduced by this parser, not an existing convention: the only annualisation
 * this codebase already had is WORKING_DAYS_PER_YEAR in pipeline/normalise.ts,
 * which converts days to years and says nothing about hours.
 */
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

function isBadge(line: string): boolean {
  return BADGES.has(line.trim().toLowerCase());
}

/** " - ", " – " or " — ": the separator between employer and location. */
function employerSplitIndex(line: string): number {
  // The dashes are all one character wide, so normalising them keeps every
  // index in the original string valid.
  return line.replace(/[–—]/g, '-').lastIndexOf(' - ');
}

/** A line that is unmistakably its own field rather than a wrapped remainder. */
function isNewField(line: string): boolean {
  return (
    /^https?:\/\//.test(line) ||
    CLICK_URL.test(line) ||
    isAgeLine(line) ||
    isBadge(line) ||
    SALARY.test(line) ||
    // An "Employer - Location" pair. Titles contain hyphens too, but a title
    // that is *continued* onto the next line almost never carries the
    // separator, whereas an employer line almost always does — and mistaking
    // the employer line for a title continuation is what loses the location.
    employerSplitIndex(line) >= 0
  );
}

/** A line the wrapper could have truncated: prose, not a URL or a badge. */
function canWrap(line: string): boolean {
  return !/^https?:\/\//.test(line) && !CLICK_URL.test(line) && !isAgeLine(line) && !isBadge(line);
}

export function parseIndeedAlert(body: string, receivedAt: Date): IndeedParseResult {
  const cut = body.search(FOOTER);
  const region = cut >= 0 ? body.slice(0, cut) : body;

  const postings: RawPosting[] = [];
  let skippedSponsored = 0;
  let skippedNoKey = 0;

  for (const block of region.split(/\n\s*\n/)) {
    const lines = joinWrappedLines(
      block
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
      { canWrap, isNewField },
    );

    const urlIndex = lines.findIndex((l) => CLICK_URL.test(l));
    // Header and footer blocks have no click-through and are not postings.
    if (urlIndex < 2) continue;

    const url = lines[urlIndex].match(CLICK_URL)![0];
    const key = url.match(JOB_KEY);
    if (!key) {
      // Two different failures, kept apart. A pagead slot is an advertisement
      // and has no job key by design; an rc/clk link with no usable key means
      // the template moved. skippedSponsored is this source's drift detector,
      // so a parser failure must not present as "Indeed is running more ads".
      if (url.includes('/pagead/')) skippedSponsored++;
      else skippedNoKey++;
      continue;
    }

    const title = lines[0];

    // The second line is the employer/location pair only when no other
    // classifier claims it. Without this test a block that omits the company
    // line — Indeed does drop it — yields an employer of "Just posted".
    const claimed = isAgeLine(lines[1]) || isBadge(lines[1]) || parseSalary(lines[1]) !== null;
    const pair: [string | null, string | null] = claimed
      ? [null, null]
      : splitEmployerLocation(lines[1]);
    const [employer, location] = pair;

    let salary: ReturnType<typeof parseSalary> = null;
    let postedAt: string | null = null;
    const snippetLines: string[] = [];

    for (const line of lines.slice(claimed ? 1 : 2, urlIndex)) {
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
      if (isBadge(line)) continue;
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

  return { postings, skippedSponsored, skippedNoKey };
}

/** "KBR - Leatherhead". Employer names contain hyphens, so split on the last one. */
function splitEmployerLocation(line: string): [string | null, string | null] {
  const at = employerSplitIndex(line);
  if (at < 0) return [line.trim() || null, null];
  return [line.slice(0, at).trim() || null, line.slice(at + 3).trim() || null];
}
