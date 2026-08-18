import { signedUrl } from '../lib/sign';
import { capsScore } from './score';
import type { Criteria, JobRow, RemoteRequirement, RunCounts, ScoredJob } from '../lib/types';

const BAND = {
  high: { at: 75, ink: '#0F7A5A', chip: '#E3F5EE', label: 'strong' },
  mid: { at: 60, ink: '#8A6100', chip: '#FBF0D8', label: 'worth reading' },
  low: { at: 0, ink: '#5A6B72', chip: '#EDF1F2', label: 'marginal' },
};

export function band(score: number) {
  if (score >= BAND.high.at) return BAND.high;
  if (score >= BAND.mid.at) return BAND.mid;
  return BAND.low;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only reads the columns that come from the jobs table, so a lead row fits too. */
export function formatSalary(job: JobRow): string {
  const { salary_min: min, salary_max: max, salary_predicted: predicted } = job;
  if (!min && !max) return 'Salary not stated';

  const daily = job.salary_period === 'daily';
  const money = (n: number) =>
    daily ? `£${Math.round(n)}` : n >= 1000 ? `£${Math.round(n / 1000)}k` : `£${Math.round(n)}`;

  const same = min && max && Math.round(min) === Math.round(max);
  const range = min && max && !same ? `${money(min)} to ${money(max)}` : money((min ?? max)!);

  // Adzuna's predicted figure is a model output, never the employer's number.
  return `${range}${daily ? '/day' : ''} ${predicted ? '(board estimate)' : '(stated)'}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'date unknown';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

interface JobLinks {
  interested: string;
  applied: string;
  notInterested: string;
  tailor: string | null;
}

async function buildLinks(
  job: ScoredJob,
  siteUrl: string,
  secret: string,
  tailorThreshold: number,
): Promise<JobLinks> {
  const track = (status: string) =>
    signedUrl(siteUrl, '/track', { job: job.id, status }, secret);
  return {
    interested: await track('interested'),
    applied: await track('applied'),
    notInterested: await track('rejected'),
    tailor:
      job.score >= tailorThreshold
        ? await signedUrl(siteUrl, '/tailor', { job: job.id }, secret)
        : null,
  };
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
}

export async function buildDigest(
  matches: ScoredJob[],
  belowThreshold: ScoredJob[],
  counts: RunCounts,
  criteria: Criteria,
  siteUrl: string,
  signingSecret: string,
): Promise<Digest> {
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const summary =
    `Fetched ${counts.fetched}, new ${counts.new_jobs}, passed filter ` +
    `${counts.prefiltered}, scored ${counts.scored}, matched ${matches.length}`;

  const links = await Promise.all(
    matches.map((job) => buildLinks(job, siteUrl, signingSecret, criteria.tailorThreshold)),
  );

  // ------------------------------------------------------------ plain text
  const textParts: string[] = [`Job Monitor: ${today}`, summary, ''];

  if (!matches.length) {
    textParts.push(
      `Nothing reached the threshold of ${criteria.minScoreForDigest} today.`,
      'The run completed normally — this is a quiet day, not a broken cron.',
      '',
    );
  }

  matches.forEach((job, i) => {
    const l = links[i];
    textParts.push(
      `--- ${job.score} | ${job.title} | ${job.employer ?? 'Employer not stated'}`,
      [
        job.contract_type === 'unknown' ? 'Contract type unknown' : capitalise(job.contract_type),
        formatSalary(job),
        `Remote confidence: ${job.remote_confidence ?? 'unknown'}`,
        job.ir35_signal && job.ir35_signal !== 'n/a' ? `IR35: ${job.ir35_signal}` : null,
      ].filter(Boolean).join(' | '),
      job.remote_evidence ? `"${job.remote_evidence}"` : '(no remote wording quoted)',
      job.reason ?? '',
      job.red_flags.length ? `Red flags: ${job.red_flags.join(', ')}` : '',
      `View: ${job.url}`,
      `Mark: [interested] ${l.interested}`,
      `      [applied] ${l.applied}`,
      `      [not interested] ${l.notInterested}`,
      l.tailor ? `Tailor CV and cover letter: ${l.tailor}` : '',
      '',
    );
  });

  if (belowThreshold.length) {
    textParts.push(`Filtered out ${belowThreshold.length} today: ${summariseRejects(belowThreshold, criteria.remoteRequirement)}.`);
  }
  textParts.push('', `All postings: ${siteUrl}`);

  // ------------------------------------------------------------ html
  const rows = matches
    .map((job, i) => jobCardHtml(job, links[i]))
    .join('');

  const emptyState = matches.length
    ? ''
    : `<tr><td style="padding:28px 24px;background:#ffffff;border:1px solid #E1E7E9;border-radius:10px;">
         <div style="font:600 15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16242A;">
           Nothing reached ${criteria.minScoreForDigest} today.</div>
         <div style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#5A6B72;margin-top:6px;">
           The run completed normally. This is a quiet day, not a broken cron.</div>
       </td></tr><tr><td style="height:12px"></td></tr>`;

  const filteredNote = belowThreshold.length
    ? `<tr><td style="padding:14px 4px;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#7A8B92;">
         Filtered out ${belowThreshold.length} today: ${escapeHtml(summariseRejects(belowThreshold, criteria.remoteRequirement))}.
       </td></tr>`
    : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Monitor: ${escapeHtml(today)}</title></head>
<body style="margin:0;padding:0;background:#F2F5F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F5F6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">

  <tr><td style="padding-bottom:18px;border-bottom:2px solid #16242A;">
    <div style="font:700 20px/1.2 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16242A;letter-spacing:-0.01em;">
      Job Monitor</div>
    <div style="font:400 13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#5A6B72;margin-top:6px;">
      ${escapeHtml(today)} &nbsp;·&nbsp; ${escapeHtml(summary)}</div>
  </td></tr>
  <tr><td style="height:20px"></td></tr>

  ${emptyState}
  ${rows}
  ${filteredNote}

  <tr><td style="padding-top:18px;border-top:1px solid #DDE4E6;
      font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#7A8B92;">
    <a href="${escapeHtml(siteUrl)}" style="color:#C4553E;text-decoration:none;font-weight:600;">Open the portal</a>
    &nbsp;to filter everything scored so far and update statuses.
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  const subject = matches.length
    ? `Job Monitor: ${matches.length} match${matches.length === 1 ? '' : 'es'} — top score ${matches[0].score}`
    : `Job Monitor: no matches today (${counts.scored} scored)`;

  return { subject, text: textParts.join('\n'), html };
}

function jobCardHtml(job: ScoredJob, l: JobLinks): string {
  const b = band(job.score);
  const meta = [
    job.contract_type === 'unknown' ? 'Contract type unknown' : capitalise(job.contract_type),
    formatSalary(job),
    `Remote: ${job.remote_confidence ?? 'unknown'}`,
    job.ir35_signal && job.ir35_signal !== 'n/a' ? `IR35 ${job.ir35_signal}` : null,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  const evidence = job.remote_evidence
    ? `<div style="margin:12px 0 0;padding:10px 12px;background:#F7FAFA;border-left:3px solid ${b.ink};
         font:400 13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#3C4E55;">
         “${escapeHtml(job.remote_evidence)}”</div>`
    : `<div style="margin:12px 0 0;padding:10px 12px;background:#FBF7F6;border-left:3px solid #C4553E;
         font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#8A4636;">
         No remote wording was quoted. Treat the remote claim as unverified.</div>`;

  const flags = job.red_flags.length
    ? `<div style="margin-top:10px;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#8A4636;">
         Red flags: ${escapeHtml(job.red_flags.join(', '))}</div>`
    : '';

  const link = (href: string, text: string, primary = false) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 6px 6px 0;padding:7px 12px;
       border:1px solid ${primary ? '#C4553E' : '#CFD8DA'};border-radius:6px;text-decoration:none;
       font:600 12px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
       color:${primary ? '#ffffff' : '#3C4E55'};background:${primary ? '#C4553E' : '#ffffff'};">${text}</a>`;

  return `<tr><td style="background:#ffffff;border:1px solid #E1E7E9;border-left:4px solid ${b.ink};border-radius:10px;padding:18px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:top;width:52px;">
        <div style="font:700 26px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${b.ink};">${job.score}</div>
        <div style="font:600 9px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#84969C;
             text-transform:uppercase;letter-spacing:0.08em;margin-top:2px;">${b.label}</div>
      </td>
      <td style="vertical-align:top;padding-left:8px;">
        <div style="font:600 16px/1.35 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16242A;">
          ${escapeHtml(job.title)}</div>
        <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#5A6B72;margin-top:3px;">
          ${escapeHtml(job.employer ?? 'Employer not stated')}</div>
        <div style="font:400 12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#7A8B92;margin-top:8px;">
          ${meta}</div>
      </td>
    </tr></table>

    ${evidence}
    <div style="margin-top:10px;font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#3C4E55;">
      ${escapeHtml(job.reason ?? '')}</div>
    ${flags}

    <div style="margin-top:14px;">
      ${link(job.url, 'View posting', true)}
      ${link(l.interested, 'Interested')}
      ${link(l.applied, 'Applied')}
      ${link(l.notInterested, 'Not interested')}
      ${l.tailor ? link(l.tailor, 'Tailor CV') : ''}
    </div>
  </td></tr>
  <tr><td style="height:12px"></td></tr>`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * "3 excluded on attendance, 1 seniority below" — why the near-misses missed.
 *
 * Keyed on capsScore rather than remote_confidence: those used to be the same
 * thing when remoteRequirement was always strict, but under a non-strict
 * level a posting silent on location (low/unstated confidence) is perfectly
 * acceptable — it missed on fit, not on remoteness — and capsScore is what
 * actually decided the outcome. A NULL attendance (the legacy scores that
 * predate the column) makes capsScore return false, so those are correctly
 * left out of this count rather than counted as remote rejects.
 */
export function summariseRejects(jobs: ScoredJob[], requirement: RemoteRequirement): string {
  let excludedOnAttendance = 0;
  let seniority = 0;
  let ir35 = 0;
  let failed = 0;
  let other = 0;

  for (const job of jobs) {
    if (job.score === -1) failed++;
    else if (capsScore(requirement, job.attendance)) excludedOnAttendance++;
    else if (job.seniority_fit === 'below') seniority++;
    else if (job.ir35_signal === 'inside') ir35++;
    else other++;
  }

  const parts = [
    excludedOnAttendance ? `${excludedOnAttendance} excluded on attendance` : null,
    seniority ? `${seniority} seniority below` : null,
    ir35 ? `${ir35} inside IR35` : null,
    failed ? `${failed} scoring failed` : null,
    other ? `${other} other` : null,
  ].filter(Boolean);

  return parts.join(', ') || 'none';
}

export async function buildWeeklySummary(
  active: ScoredJob[],
  siteUrl: string,
): Promise<Digest> {
  const now = Date.now();
  const ageDays = (iso: string | null) =>
    iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : 0;

  const text = [
    'Job Monitor: weekly application summary',
    '',
    ...(active.length
      ? active.map(
          (j) =>
            `${String(j.status).toUpperCase()} ${ageDays(j.status_updated_at)}d — ${j.title} | ${j.employer ?? 'unknown'}\n  ${j.url}`,
        )
      : ['Nothing is currently at applied or interviewing.']),
    '',
    `Portal: ${siteUrl}`,
  ].join('\n');

  const rows = active.length
    ? active
        .map(
          (j) => `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #E1E7E9;font:600 12px/1.4 ui-monospace,Menlo,Consolas,monospace;
          color:${j.status === 'interviewing' ? '#0F7A5A' : '#8A6100'};text-transform:uppercase;">${escapeHtml(String(j.status))}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #E1E7E9;font:400 14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16242A;">
        <a href="${escapeHtml(j.url)}" style="color:#16242A;text-decoration:none;font-weight:600;">${escapeHtml(j.title)}</a>
        <div style="color:#5A6B72;font-size:13px;">${escapeHtml(j.employer ?? 'Employer not stated')}</div></td>
      <td style="padding:10px 12px;border-bottom:1px solid #E1E7E9;font:400 13px/1.4 ui-monospace,Menlo,Consolas,monospace;
          color:#7A8B92;text-align:right;white-space:nowrap;">${ageDays(j.status_updated_at)}d</td>
    </tr>`,
        )
        .join('')
    : `<tr><td colspan="3" style="padding:20px 12px;font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#5A6B72;">
         Nothing is currently at applied or interviewing.</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly application summary</title></head>
<body style="margin:0;background:#F2F5F6;padding:24px 12px;">
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
  <tr><td style="padding-bottom:16px;border-bottom:2px solid #16242A;">
    <div style="font:700 20px/1.2 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16242A;">Applications in flight</div>
    <div style="font:400 13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#5A6B72;margin-top:6px;">
      ${active.length} open · oldest first</div>
  </td></tr>
  <tr><td style="height:16px"></td></tr>
  <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:#fff;border:1px solid #E1E7E9;border-radius:10px;">${rows}</table></td></tr>
  <tr><td style="padding-top:16px;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#7A8B92;">
    <a href="${escapeHtml(siteUrl)}" style="color:#C4553E;font-weight:600;text-decoration:none;">Open the portal</a> to update statuses.
  </td></tr>
</table></body></html>`;

  return {
    subject: `Job Monitor: ${active.length} application${active.length === 1 ? '' : 's'} in flight`,
    text,
    html,
  };
}
