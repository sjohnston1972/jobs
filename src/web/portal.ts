import type { PortalFilter, PortalStats } from '../lib/db';
import { escapeHtml, formatDate, formatSalary } from '../pipeline/digest';
import type { Criteria, PortalJob, ScoredJob } from '../lib/types';
import { STYLES } from './styles';

const FONTS =
  'https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;700;800&' +
  'family=Inter+Tight:wght@400;500;600;700&display=swap';

export function layout(title: string, body: string, extraScript = ''): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<!-- viewport-fit=cover lets the safe-area insets in the stylesheet do their job
     on notched phones; the shell pads itself back out. -->
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0A1113" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#EEF2F2" media="(prefers-color-scheme: light)">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="%230A1113"/><rect x="3" y="4" width="10" height="2" rx="1" fill="%234FD1A5"/><rect x="3" y="7" width="7" height="2" rx="1" fill="%23E8B94A"/><rect x="3" y="10" width="4" height="2" rx="1" fill="%23FF7A66"/></svg>',
  )}">
<style>${STYLES}</style>
</head>
<body>
${body}
${extraScript ? `<script>${extraScript}</script>` : ''}
</body>
</html>`;
}

// ------------------------------------------------------------------ helpers

type Band = 'high' | 'mid' | 'low' | 'fail' | 'lead';

function bandOf(score: number | null): { key: Band; colour: string; label: string; lit: number } {
  // Never scored, by design — not scored badly. Rendered without a number at
  // all, because a 0 here would read as "assessed and rejected".
  if (score === null) return { key: 'lead', colour: 'var(--dim)', label: 'lead', lit: 0 };
  if (score < 0) return { key: 'fail', colour: 'var(--sig-fail)', label: 'error', lit: 0 };
  if (score >= 75) return { key: 'high', colour: 'var(--sig-high)', label: 'strong', lit: 3 };
  if (score >= 60) return { key: 'mid', colour: 'var(--sig-mid)', label: 'read', lit: 2 };
  return { key: 'low', colour: 'var(--sig-low)', label: 'marginal', lit: 1 };
}

function confidenceLit(confidence: string | null): number {
  return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : confidence === 'low' ? 1 : 0;
}

function queryFor(current: PortalFilter, patch: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  const merged: Record<string, unknown> = {
    min: current.minScore,
    status: current.status,
    source: current.source,
    contract: current.contract,
    remote: current.remote,
    q: current.search,
    sort: current.sort,
    // Carried as the string '1' or dropped entirely; a literal `false` would
    // otherwise be serialised as "leads=false" and read back as truthy-looking.
    leads: current.leads ? '1' : undefined,
    ...patch,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `/?${qs}` : '/';
}

function chip(
  label: string,
  href: string,
  active: boolean,
): string {
  return `<a class="chip" href="${escapeHtml(href)}" aria-pressed="${active}">${escapeHtml(label)}</a>`;
}

// ------------------------------------------------------------------ portal

export function renderPortal(
  jobs: PortalJob[],
  stats: PortalStats,
  filter: PortalFilter,
  criteria: Criteria,
  lastRun: Record<string, unknown> | null,
  viewer: string,
): string {
  const lastRunAt = lastRun?.finished_at ?? lastRun?.started_at;
  const hoursSince = lastRunAt
    ? Math.floor((Date.now() - Date.parse(String(lastRunAt))) / 3_600_000)
    : null;
  const stale = hoursSince !== null && hoursSince > 30;

  const readouts = [
    { value: String(stats.matches), label: `at ${criteria.minScoreForDigest}+`, mod: 'live' },
    { value: String(stats.new_today), label: 'new today', mod: '' },
    { value: String(stats.total_scored), label: 'scored', mod: '' },
    { value: String(stats.total_jobs), label: 'collected', mod: '' },
    { value: String(stats.applied), label: 'applied', mod: stats.applied ? 'warn' : '' },
    { value: String(stats.interviewing), label: 'interviews', mod: stats.interviewing ? 'live' : '' },
  ]
    .map(
      (r) => `<div class="readout${r.mod ? ` readout--${r.mod}` : ''}">
        <div class="readout__value">${escapeHtml(r.value)}</div>
        <div class="readout__label">${escapeHtml(r.label)}</div>
      </div>`,
    )
    .join('');

  const staleNotice = stale
    ? `<div class="notice">The last run finished ${hoursSince} hours ago. The daily trigger
       fires at 06:00 UTC — if that is more than a day, check <a href="/health">/health</a>.</div>`
    : '';

  // Only rendered when the request asked for leads, so the default view is
  // byte-for-byte what it was before leads existed.
  const leadsNotice = filter.leads
    ? `<div class="notice">Showing leads as well as scored postings. LinkedIn alert emails
       carry no description, so those postings are collected but never scored — they show a
       dash instead of a score. <a href="${escapeHtml(queryFor(filter, { leads: undefined, source: undefined }))}">Scored only</a>.</div>`
    : '';

  const scoreChips = [
    { label: 'all', value: undefined },
    { label: `${criteria.minScoreForDigest}+`, value: String(criteria.minScoreForDigest) },
    { label: '75+', value: '75' },
  ]
    .map((c) =>
      chip(
        c.label,
        queryFor(filter, { min: c.value }),
        String(filter.minScore ?? '') === (c.value ?? ''),
      ),
    )
    .join('');

  const statusChips = [
    { label: 'any', value: undefined },
    { label: 'untouched', value: 'none' },
    { label: 'interested', value: 'interested' },
    { label: 'applied', value: 'applied' },
    { label: 'interviewing', value: 'interviewing' },
  ]
    .map((c) => chip(c.label, queryFor(filter, { status: c.value }), (filter.status ?? '') === (c.value ?? '')))
    .join('');

  const remoteChips = [
    { label: 'any', value: undefined },
    { label: 'high', value: 'high' },
    { label: 'medium', value: 'medium' },
  ]
    .map((c) => chip(c.label, queryFor(filter, { remote: c.value }), (filter.remote ?? '') === (c.value ?? '')))
    .join('');

  const sortChips = [
    { label: 'score', value: undefined },
    { label: 'posted', value: 'posted' },
  ]
    .map((c) => chip(c.label, queryFor(filter, { sort: c.value }), (filter.sort ?? '') === (c.value ?? '')))
    .join('');

  // Drives the badge on the collapsed toggle, so a filtered view never looks
  // like an empty one on a phone.
  const activeFilters = [filter.minScore, filter.status, filter.remote, filter.sort].filter(
    (v) => v !== undefined && v !== null && v !== '',
  ).length;

  const stack = jobs.length
    ? `<div class="stack">${jobs.map((job, i) => renderUnit(job, i, criteria)).join('')}</div>`
    : renderEmpty(filter, criteria);

  const body = `
<div class="shell">

  <header class="masthead">
    <div class="brand">
      <h1 class="brand__name">Job Monitor</h1>
      <div class="brand__sub">Reed + Adzuna + Indeed + LinkedIn &nbsp;·&nbsp; fully remote only &nbsp;·&nbsp;
        last run ${hoursSince === null ? 'never' : `${hoursSince}h ago`}</div>
    </div>
    <div class="readouts">${readouts}</div>
  </header>

  <form class="controls" method="get" action="/">
    <input class="search" type="search" name="q" placeholder="Filter by title or employer"
           value="${escapeHtml(filter.search ?? '')}" aria-label="Filter by title or employer">
    ${filter.minScore !== undefined ? `<input type="hidden" name="min" value="${filter.minScore}">` : ''}
    ${filter.status ? `<input type="hidden" name="status" value="${escapeHtml(filter.status)}">` : ''}
    ${filter.remote ? `<input type="hidden" name="remote" value="${escapeHtml(filter.remote)}">` : ''}
    ${filter.sort ? `<input type="hidden" name="sort" value="${escapeHtml(filter.sort)}">` : ''}
    ${filter.leads ? `<input type="hidden" name="leads" value="1">` : ''}
    ${filter.source ? `<input type="hidden" name="source" value="${escapeHtml(filter.source)}">` : ''}
    <button class="btn" type="submit">Search</button>

    <input class="filters__check" type="checkbox" id="filters-toggle"${activeFilters ? ' checked' : ''}>
    <label class="filters__toggle" for="filters-toggle">Filters${
      activeFilters ? ` <span class="filters__count">${activeFilters}</span>` : ''
    }</label>

    <div class="filters__body">
      <div class="chipset"><span class="chipset__label">Score</span>${scoreChips}</div>
      <div class="chipset"><span class="chipset__label">Status</span>${statusChips}</div>
      <div class="chipset"><span class="chipset__label">Remote</span>${remoteChips}</div>
      <div class="chipset"><span class="chipset__label">Sort</span>${sortChips}</div>
    </div>
  </form>

  ${staleNotice}
  ${leadsNotice}
  ${stack}

  <footer class="footer">
    <span>${jobs.length} shown &nbsp;·&nbsp; threshold ${criteria.minScoreForDigest} &nbsp;·&nbsp; scored by ${escapeHtml(criteria.scoringModel)}</span>
    <span>${escapeHtml(viewer)} &nbsp;·&nbsp; <a href="/cdn-cgi/access/logout">Sign out</a>
      &nbsp;·&nbsp; <a href="/health">/health</a></span>
  </footer>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`;

  return layout('Job Monitor', body, CLIENT_SCRIPT);
}

function renderEmpty(filter: PortalFilter, criteria: Criteria): string {
  const filtered =
    filter.minScore !== undefined || filter.status || filter.remote || filter.search;
  return `<div class="empty">
    <div class="empty__title">${filtered ? 'Nothing matches those filters.' : 'No postings scored yet.'}</div>
    <div class="empty__body">${
      filtered
        ? `Clear them to see everything collected so far. <a href="/">Show all</a>`
        : `The collector runs daily at 06:00 UTC. Trigger one now with
           <code>/run?key=…</code>, or check <a href="/health">/health</a> for the last result.`
    }</div>
  </div>`;
}

function renderUnit(job: PortalJob, index: number, criteria: Criteria): string {
  const b = bandOf(job.score);
  const unscored = job.score === null;
  const lit = confidenceLit(job.remote_confidence);

  const meter = [0, 1, 2]
    .map((i) => `<span class="meter__seg${i < lit ? ' meter__seg--lit' : ''}"></span>`)
    .join('');

  const specs: string[] = [];
  specs.push(
    `<span class="spec">${escapeHtml(
      job.contract_type === 'unknown' ? 'type unknown' : job.contract_type,
    )}</span>`,
  );
  specs.push(
    `<span class="spec${job.salary_predicted ? ' spec--est' : ''}">${escapeHtml(formatSalary(job))}</span>`,
  );
  specs.push(
    `<span class="spec${job.remote_confidence === 'high' ? ' spec--good' : job.remote_confidence === 'low' ? ' spec--flag' : ''}">remote ${escapeHtml(job.remote_confidence ?? 'unknown')}</span>`,
  );
  if (job.ir35_signal && job.ir35_signal !== 'n/a') {
    specs.push(
      `<span class="spec${job.ir35_signal === 'inside' ? ' spec--flag' : job.ir35_signal === 'outside' ? ' spec--good' : ''}">ir35 ${escapeHtml(job.ir35_signal)}</span>`,
    );
  }
  if (job.seniority_fit && job.seniority_fit !== 'match') {
    specs.push(`<span class="spec${job.seniority_fit === 'below' ? ' spec--flag' : ''}">level ${escapeHtml(job.seniority_fit)}</span>`);
  }
  specs.push(`<span class="spec">${escapeHtml(job.source)}</span>`);
  specs.push(`<span class="spec">${escapeHtml(formatDate(job.posted_at))}</span>`);

  // Red flags come back as sentences, so they get a list of their own rather
  // than sitting in the spec row as unbreakable chips.
  const flags = job.red_flags.length
    ? `<div class="flags">
         <span class="flags__tag">Red flags</span>
         <ul class="flags__list">${job.red_flags
           .map((flag) => `<li>${escapeHtml(flag)}</li>`)
           .join('')}</ul>
       </div>`
    : '';

  const capture = job.remote_evidence
    ? `<blockquote class="capture">
         <span class="capture__tag">Remote evidence</span>“${escapeHtml(job.remote_evidence)}”
       </blockquote>`
    : unscored
      ? `<div class="capture capture--missing">
           <span class="capture__tag">Not scored</span>
           A ${escapeHtml(job.source)} alert email carries no description, so there is nothing
           for the scorer to read. Collected as a lead — open the posting to judge it yourself.
         </div>`
      : `<div class="capture capture--missing">
         <span class="capture__tag">Remote evidence</span>
         Nothing in the description was quoted. Treat the remote claim as unverified.
       </div>`;

  const statusButtons = (['interested', 'applied', 'interviewing', 'rejected'] as const)
    .map(
      (s) =>
        `<button class="btn${job.status === s ? ' btn--on' : ''}" data-status="${s}" data-job="${escapeHtml(job.id)}"
           type="button">${s === 'interviewing' ? 'interview' : s}</button>`,
    )
    .join('');

  const tailorButton =
    job.score !== null && job.score >= criteria.tailorThreshold
      ? `<button class="btn" type="button" data-tailor="${escapeHtml(job.id)}">Tailor CV</button>`
      : '';

  return `<article class="unit" style="--band:${b.colour};--i:${index}" data-open="false" data-job="${escapeHtml(job.id)}">
  <div class="unit__face">

    <div class="well">
      <div class="well__score">${unscored ? '—' : job.score! < 0 ? '!!' : job.score}</div>
      <div class="well__band">${escapeHtml(b.label)}</div>
      <div class="meter" title="Remote confidence: ${escapeHtml(job.remote_confidence ?? 'unknown')}"
           role="img" aria-label="Remote confidence ${escapeHtml(job.remote_confidence ?? 'unknown')}">${meter}</div>
    </div>

    <div class="unit__body">
      <h2 class="unit__title"><a href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.title)}</a></h2>
      <div class="unit__employer">${escapeHtml(job.employer ?? 'Employer not stated')}${
        job.location_raw ? ` &nbsp;·&nbsp; ${escapeHtml(job.location_raw)}` : ''
      }</div>
      <div class="specs">${specs.join('')}</div>
      ${capture}
      <p class="reason">${escapeHtml(job.reason ?? '')}</p>
      ${flags}
    </div>

    <div class="actions">
      <a class="btn btn--primary" href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer">View posting</a>
      <button class="btn" type="button" data-expand>Description</button>
      ${tailorButton}
      <div class="statusbar">${statusButtons}</div>
    </div>

  </div>

  <div class="drawer">
    <p class="drawer__label">Description as collected${job.description_truncated ? ' (excerpt from the board)' : ''}</p>
    <div class="drawer__text">${escapeHtml((job.description ?? '').slice(0, 6000) || 'No description was stored.')}</div>
    <div class="drawer__meta">
      <span>${escapeHtml(job.id)}</span>
      <span>first seen ${escapeHtml(formatDate(job.first_seen_at))}</span>
      <span>${unscored ? 'never scored' : `scored ${escapeHtml(formatDate(job.scored_at))}`}</span>
      ${job.status ? `<span>status ${escapeHtml(job.status)} · ${escapeHtml(formatDate(job.status_updated_at))}</span>` : ''}
    </div>
  </div>
</article>`;
}

// ------------------------------------------------------------------ client

const CLIENT_SCRIPT = /* js */ `
(function () {
  var toast = document.getElementById('toast');
  var timer;
  function say(message, kind) {
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.kind = kind || 'ok';
    toast.dataset.show = 'true';
    clearTimeout(timer);
    timer = setTimeout(function () { toast.dataset.show = 'false'; }, 2600);
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;

    var expand = target.closest('[data-expand]');
    if (expand) {
      var unit = expand.closest('.unit');
      var open = unit.dataset.open === 'true';
      unit.dataset.open = open ? 'false' : 'true';
      expand.textContent = open ? 'Description' : 'Hide';
      return;
    }

    var statusBtn = target.closest('[data-status]');
    if (statusBtn) {
      var jobId = statusBtn.getAttribute('data-job');
      var status = statusBtn.getAttribute('data-status');
      var group = statusBtn.closest('.statusbar');
      statusBtn.disabled = true;
      fetch('/api/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job: jobId, status: status })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        group.querySelectorAll('.btn').forEach(function (b) { b.classList.remove('btn--on'); });
        statusBtn.classList.add('btn--on');
        say('Marked ' + status);
      }).catch(function () {
        say('Could not save that status', 'error');
      }).finally(function () {
        statusBtn.disabled = false;
      });
      return;
    }

    var tailorBtn = target.closest('[data-tailor]');
    if (tailorBtn) {
      var id = tailorBtn.getAttribute('data-tailor');
      tailorBtn.disabled = true;
      tailorBtn.textContent = 'Writing…';
      say('Drafting CV and cover letter');
      fetch('/api/tailor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job: id })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        window.location.href = '/tailored?job=' + encodeURIComponent(id);
      }).catch(function () {
        say('Tailoring failed', 'error');
        tailorBtn.disabled = false;
        tailorBtn.textContent = 'Tailor CV';
      });
    }
  });
})();
`;

// ------------------------------------------------------------------ small pages

export function renderTrackConfirm(job: ScoredJob | null, status: string): string {
  const body = `<div class="prose">
  <h1>Status updated</h1>
  <p style="color:var(--dim);font-size:15px;line-height:1.6;">
    ${job ? `<strong style="color:var(--text)">${escapeHtml(job.title)}</strong>
             at ${escapeHtml(job.employer ?? 'an unnamed employer')}` : 'That posting'}
    is now marked <strong style="color:var(--accent)">${escapeHtml(status)}</strong>.
  </p>
  <p style="margin-top:26px;"><a class="btn btn--primary" style="display:inline-block;text-decoration:none;"
     href="/">Open the portal</a></p>
</div>`;
  return layout('Status updated — Job Monitor', body);
}

export function renderMessage(title: string, message: string): string {
  const body = `<div class="prose">
  <h1>${escapeHtml(title)}</h1>
  <p style="color:var(--dim);font-size:15px;line-height:1.6;">${escapeHtml(message)}</p>
  <p style="margin-top:26px;"><a href="/">Back to the portal</a></p>
</div>`;
  return layout(`${title} — Job Monitor`, body);
}

export function renderTailored(
  job: ScoredJob,
  cvSummary: string,
  coverLetter: string,
  model: string,
  createdAt: string,
): string {
  const body = `<div class="prose">
  <h1>Tailored draft</h1>
  <p style="color:var(--dim);font-size:15px;line-height:1.6;margin-top:10px;">
    <strong style="color:var(--text)">${escapeHtml(job.title)}</strong> at
    ${escapeHtml(job.employer ?? 'an unnamed employer')} &nbsp;·&nbsp; score ${job.score}<br>
    <span style="font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dimmer)">
      ${escapeHtml(model)} · ${escapeHtml(formatDate(createdAt))} · draft, not for sending unread</span>
  </p>

  <h2>CV summary</h2>
  <pre>${escapeHtml(cvSummary)}</pre>

  <h2>Cover letter</h2>
  <pre>${escapeHtml(coverLetter)}</pre>

  <p style="margin-top:30px;display:flex;gap:8px;flex-wrap:wrap;">
    <a class="btn btn--primary" style="text-decoration:none;" href="${escapeHtml(job.url)}"
       target="_blank" rel="noopener noreferrer">View posting</a>
    <a class="btn" style="text-decoration:none;" href="/">Back to the portal</a>
  </p>
</div>`;
  return layout('Tailored draft — Job Monitor', body);
}
