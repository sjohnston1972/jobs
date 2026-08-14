import type { RawPosting } from './types';
import { joinWrappedLines } from './wrap';

/**
 * Postings are separated by a rule; its length varies between sections. The
 * split is no longer load-bearing — a rule shorter than this simply stays in
 * the block as an ordinary line, and every link in a block is walked — but
 * splitting on the long rules keeps blocks small and the trio lookup local.
 */
const RULE = /^-{10,}$/m;

/** A rule of any length, as it survives inside a block. */
const RULE_LINE = /^-{3,}$/;

const VIEW_JOB = /^View job:\s*(\S*)/;

/** e.g. https://www.linkedin.com/comm/jobs/view/4449839863/?trackingId=... */
const JOB_ID = /\/jobs\/view\/(\d+)/;

/**
 * Lines LinkedIn places between the location and the link. They must be
 * discarded before the title block is located, otherwise two badges look
 * exactly like a title and an employer.
 */
const BADGE =
  /^(?:\d+ company alum(?:ni)?|This company is actively hiring|Apply with resume & profile|Be an early applicant|Actively recruiting|Promoted|Easy Apply)$/i;

/** A line that is unmistakably its own field rather than a wrapped remainder. */
function isNewField(line: string): boolean {
  return (
    VIEW_JOB.test(line) ||
    /^https?:\/\//.test(line) ||
    RULE_LINE.test(line) ||
    BADGE.test(line)
  );
}

/** A line the wrapper could have truncated: prose, not a link or a badge. */
function canWrap(line: string): boolean {
  return !isNewField(line);
}

/** Lines that can be part of the title/employer/location trio. */
function isTrioLine(line: string): boolean {
  return !BADGE.test(line) && !RULE_LINE.test(line) && !VIEW_JOB.test(line) && !/^https?:\/\//.test(line);
}

export function parseLinkedInAlert(body: string, receivedAt: Date): RawPosting[] {
  const postings: RawPosting[] = [];

  for (const block of body.split(RULE)) {
    // Paragraph groups, because the title/employer/location trio is its own
    // paragraph and the alert header is another — position alone would take
    // the header for the first posting.
    const groups = block
      .split(/\n\s*\n/)
      .map((g) =>
        joinWrappedLines(
          g.split('\n').map((l) => l.trim()).filter(Boolean),
          { canWrap, isNewField },
        ),
      )
      .filter((g) => g.length);

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      // Every link in the group is walked, not only the first. When LinkedIn
      // uses a rule shorter than RULE the postings either side of it land in
      // one block, and taking only the first link dropped the second silently.
      // `consumed` marks how much of the group a previous posting already
      // claimed, so two postings in one group each get their own lines.
      let consumed = 0;

      for (let i = 0; i < group.length; i++) {
        const linkMatch = group[i].match(VIEW_JOB);
        if (!linkMatch) continue;

        // The URL usually sits on the "View job:" line, but it wraps. When it
        // does, the remainder is the next line and joins on with no space.
        let id = linkMatch[1].match(JOB_ID);
        let lastLine = i;
        if (!id && group[i + 1] !== undefined) {
          id = `${linkMatch[1]}${group[i + 1]}`.match(JOB_ID);
          if (id) lastLine = i + 1;
        }
        if (!id) {
          consumed = i + 1;
          continue;
        }

        // Usually the trio sits in the preceding group. When LinkedIn omits
        // the blank line it shares a group with the link, so prefer whatever
        // real content sits above the link once badges and rules are removed.
        const sameGroup = group.slice(consumed, i).filter(isTrioLine);
        const previous =
          consumed === 0 ? (groups[g - 1] ?? []).filter(isTrioLine) : [];
        const trio = sameGroup.length >= 2 ? sameGroup : previous;
        consumed = lastLine + 1;
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
    }
  }

  return postings;
}
