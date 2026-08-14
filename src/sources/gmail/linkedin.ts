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
