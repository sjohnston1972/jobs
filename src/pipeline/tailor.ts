import { callClaude, extractJson } from '../lib/claude';
import type { Criteria, JobRow } from '../lib/types';

const SYSTEM_PROMPT = `You write job application material for one specific candidate.

Ground rules:
- Use only what is in the candidate profile. Never invent an employer, a date, a
  certification, a metric or a technology the profile does not contain.
- Mirror the posting's own vocabulary where the profile genuinely supports it.
  If the posting wants something the candidate does not have, leave it out
  rather than implying it.
- British English. Plain, direct sentences. No filler openers, no "I am writing
  to express my interest", no superlatives about passion.
- The cover letter is at most four short paragraphs and does not repeat the CV
  line by line; it argues why this particular candidate suits this particular
  posting.
- The CV summary is 4 to 6 bullet points, each one line, reordered and reworded
  to lead with what this posting cares about most.

Return a single JSON object and nothing else.`;

interface RawTailor {
  cv_summary?: unknown;
  cover_letter?: unknown;
}

export interface TailoredDraft {
  cvSummary: string;
  coverLetter: string;
  model: string;
}

export async function tailorForJob(
  apiKey: string,
  job: JobRow,
  profile: string,
  criteria: Criteria,
): Promise<TailoredDraft> {
  const model = criteria.tailoringModel;

  const prompt = `<candidate_profile>
${profile}
</candidate_profile>

<posting>
Title: ${job.title}
Employer: ${job.employer ?? 'not stated'}
Location: ${job.location_raw ?? 'not stated'}
Contract type: ${job.contract_type}

${(job.description ?? '').slice(0, 12000)}
</posting>

Write application material for this posting. Return JSON matching exactly:

{
  "cv_summary": "4-6 bullet points as plain text, one per line, each starting with '- '",
  "cover_letter": "the letter as plain text with blank lines between paragraphs"
}`;

  const raw = await callClaude(apiKey, {
    model,
    system: SYSTEM_PROMPT,
    prompt,
    // Thinking is on by default on the 5-series and counts against max_tokens,
    // so the ceiling has to cover the reasoning as well as the letter.
    maxTokens: 8000,
    effort: 'medium',
    jsonSchema: {
      type: 'object',
      properties: {
        cv_summary: { type: 'string' },
        cover_letter: { type: 'string' },
      },
      required: ['cv_summary', 'cover_letter'],
      additionalProperties: false,
    },
  });

  const parsed = extractJson<RawTailor>(raw);
  if (!parsed) {
    throw new Error(`Tailoring returned unparseable output: ${raw.slice(0, 300)}`);
  }

  const cvSummary = typeof parsed.cv_summary === 'string' ? parsed.cv_summary.trim() : '';
  const coverLetter = typeof parsed.cover_letter === 'string' ? parsed.cover_letter.trim() : '';

  if (!cvSummary && !coverLetter) {
    throw new Error('Tailoring returned an empty draft.');
  }

  return { cvSummary, coverLetter, model };
}

export function tailoredEmail(
  job: JobRow,
  draft: TailoredDraft,
): { subject: string; text: string; html: string } {
  const subject = `Tailored draft: ${job.title}${job.employer ? ` — ${job.employer}` : ''}`;

  const text = [
    subject,
    '',
    'Both are drafts for editing, never for sending unread.',
    '',
    '--- CV SUMMARY ---',
    draft.cvSummary,
    '',
    '--- COVER LETTER ---',
    draft.coverLetter,
    '',
    `Posting: ${job.url}`,
  ].join('\n');

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#F2F5F6;padding:24px 12px;">
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:660px;">
  <tr><td style="padding-bottom:14px;border-bottom:2px solid #16242A;">
    <div style="font:700 19px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16242A;">${esc(job.title)}</div>
    <div style="font:400 13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#5A6B72;margin-top:5px;">
      ${esc(job.employer ?? 'Employer not stated')} · ${esc(draft.model)} · draft, not for sending unread</div>
  </td></tr>
  <tr><td style="padding:22px 0 8px;font:700 11px/1 ui-monospace,Menlo,Consolas,monospace;
      letter-spacing:.12em;text-transform:uppercase;color:#7A8B92;">CV summary</td></tr>
  <tr><td><pre style="margin:0;padding:16px;background:#fff;border:1px solid #E1E7E9;border-radius:8px;
      font:400 13px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#16242A;white-space:pre-wrap;">${esc(draft.cvSummary)}</pre></td></tr>
  <tr><td style="padding:22px 0 8px;font:700 11px/1 ui-monospace,Menlo,Consolas,monospace;
      letter-spacing:.12em;text-transform:uppercase;color:#7A8B92;">Cover letter</td></tr>
  <tr><td><pre style="margin:0;padding:16px;background:#fff;border:1px solid #E1E7E9;border-radius:8px;
      font:400 13px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#16242A;white-space:pre-wrap;">${esc(draft.coverLetter)}</pre></td></tr>
  <tr><td style="padding-top:20px;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;">
    <a href="${esc(job.url)}" style="color:#C4553E;font-weight:600;text-decoration:none;">View the posting</a></td></tr>
</table></body></html>`;

  return { subject, text, html };
}
