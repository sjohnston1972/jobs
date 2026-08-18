import { escapeHtml } from '../pipeline/digest';
import { layout } from './portal';
import { MODEL_IDS, SETTABLE_KEYS } from '../lib/settings-schema';
import type { Criteria } from '../lib/types';

type Group = { title: string; note?: string; keys: string[] };

const GROUPS: Group[] = [
  {
    title: 'Scoring',
    // Shown together on purpose: the tailor link needs the higher of the two,
    // and it sat at 70 while the highest score ever awarded was 42, so it had
    // never once appeared. Lowering the digest threshold alone does not fix it.
    note: 'A job needs minScoreForDigest to reach the email, and tailorThreshold to get a tailor link.',
    keys: ['minScoreForDigest', 'tailorThreshold', 'remoteRequirement'],
  },
  { title: 'Volume', keys: ['maxScoredPerRun', 'maxEmailsPerRun', 'maxEmailJobsPerRun', 'lookbackDays'] },
  { title: 'Keywords', keys: ['titleAllow', 'titleBlock', 'bodyRequireAny', 'seedQueries'] },
  { title: 'Plumbing', keys: ['gmailQuery', 'scoringModel', 'tailoringModel'] },
];

const REMOTE_LEVELS: Array<[string, string]> = [
  ['strict', 'Strict — any attendance requirement caps the score at 39'],
  ['mostly', 'Mostly remote — occasional travel is fine; fixed days or on-site cap at 39'],
  ['any', 'Any — nothing is capped; remoteness only costs points'],
];

// isOverridden is not read here — the override badge is rendered by the
// caller, which is where the flag actually matters. control() only needs
// the value that should currently sit in the field.
function control(key: string, effective: unknown): string {
  if (key === 'remoteRequirement') {
    const opts = REMOTE_LEVELS.map(
      ([v, label]) =>
        `<option value="${escapeHtml(v)}"${v === effective ? ' selected' : ''}>${escapeHtml(label)}</option>`,
    ).join('');
    return `<select class="field__control" data-key="${escapeHtml(key)}">${opts}</select>`;
  }
  if (key === 'scoringModel' || key === 'tailoringModel') {
    const opts = MODEL_IDS.map(
      (v) => `<option value="${escapeHtml(v)}"${v === effective ? ' selected' : ''}>${escapeHtml(v)}</option>`,
    ).join('');
    return `<select class="field__control" data-key="${escapeHtml(key)}">${opts}</select>`;
  }
  if (Array.isArray(effective)) {
    const items = effective
      .map(
        (term) =>
          `<li>${escapeHtml(String(term))} <button type="button" data-remove="${escapeHtml(key)}" ` +
          `data-term="${escapeHtml(String(term))}">remove</button></li>`,
      )
      .join('');
    return `<ul class="field__list" data-list="${escapeHtml(key)}">${items}</ul>
      <input class="field__control" data-add="${escapeHtml(key)}" placeholder="add term">`;
  }
  return `<input class="field__control" data-key="${escapeHtml(key)}" value="${escapeHtml(String(effective))}">`;
}

export function renderSettings(
  defaults: Criteria,
  effective: Criteria,
  overrides: Record<string, unknown>,
  rescorable: number,
): string {
  const rows = GROUPS.map((group) => {
    // Filtered against SETTABLE_KEYS so a field with no validator — contractTypes —
    // cannot be rendered even if someone adds it to a group by mistake.
    const fields = group.keys
      .filter((key) => SETTABLE_KEYS.includes(key))
      .map((key) => {
        const isOverridden = Object.prototype.hasOwnProperty.call(overrides, key);
        // Read from the loaded (validated, merged) criteria rather than the
        // raw overrides row: a row written directly with wrangler d1 execute
        // — which the plan itself teaches — or one written before a validator
        // tightened, can hold a value the run never actually uses. `overrides`
        // still decides the badge and the Reset button below, because that is
        // about whether a row exists at all, not what it currently contains.
        const value = (effective as unknown as Record<string, unknown>)[key];
        const badge = isOverridden
          ? `<span class="badge">overridden</span>
             <button type="button" class="btn" data-reset="${escapeHtml(key)}">Reset to default</button>`
          : '';
        const dflt = escapeHtml(
          Array.isArray((defaults as unknown as Record<string, unknown>)[key])
            ? ((defaults as unknown as Record<string, unknown>)[key] as unknown[]).join(', ')
            : String((defaults as unknown as Record<string, unknown>)[key]),
        );
        return `<div class="field" data-field="${escapeHtml(key)}">
            <label>${escapeHtml(key)} ${badge}</label>
            ${control(key, value)}
            <p class="default">default: ${dflt}</p>
          </div>`;
      })
      .join('');
    const note = group.note ? `<p class="note">${escapeHtml(group.note)}</p>` : '';
    return `<section><h2>${escapeHtml(group.title)}</h2>${note}${fields}</section>`;
  }).join('');

  const rescore = `<section><h2>Rescore</h2>
      <p>${rescorable} scored jobs are inside the current lookback window.
         Re-judging them costs ${rescorable} Claude calls.</p>
      <button type="button" class="btn" id="rescore" data-count="${rescorable}">Rescore these ${rescorable}</button>
    </section>`;

  return layout('Settings — Job Monitor', `<div class="prose"><h1>Settings</h1>${rows}${rescore}</div>`, SETTINGS_SCRIPT);
}

// ------------------------------------------------------------------ client

const SETTINGS_SCRIPT = /* js */ `
(function () {
  function fieldEl(key) {
    return document.querySelector('[data-field="' + key + '"]');
  }

  // Builds nodes with textContent rather than innerHTML, so a stored value
  // — the user's own settings, but still round-tripped through JSON from the
  // network — cannot be interpreted as markup when it is written back in.
  function renderControl(fieldElement, key, effective) {
    var listEl = fieldElement.querySelector('.field__list');
    if (listEl && Array.isArray(effective)) {
      listEl.textContent = '';
      effective.forEach(function (term) {
        var li = document.createElement('li');
        li.appendChild(document.createTextNode(term + ' '));
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-remove', key);
        btn.setAttribute('data-term', term);
        btn.textContent = 'remove';
        li.appendChild(btn);
        listEl.appendChild(li);
      });
      var addInput = fieldElement.querySelector('[data-add="' + key + '"]');
      if (addInput) addInput.value = '';
      return;
    }
    var input = fieldElement.querySelector('[data-key="' + key + '"]');
    if (input) input.value = effective;
  }

  function showError(fieldElement, message) {
    var existing = fieldElement.querySelector('.field__error');
    if (existing) existing.remove();
    if (!message) return;
    var p = document.createElement('p');
    p.className = 'field__error';
    p.style.color = 'var(--sig-fail)';
    p.textContent = message;
    fieldElement.appendChild(p);
  }

  function save(key, value) {
    var fieldElement = fieldEl(key);
    return fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key, value: value })
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || data.error) {
          if (fieldElement) showError(fieldElement, data.error || ('HTTP ' + r.status));
          return;
        }
        if (fieldElement) {
          showError(fieldElement, null);
          renderControl(fieldElement, key, data.effective);
        }
      });
    }).catch(function () {
      if (fieldElement) showError(fieldElement, 'Could not save that setting');
    });
  }

  function reset(key) {
    var fieldElement = fieldEl(key);
    return fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key, reset: true })
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || data.error) {
          if (fieldElement) showError(fieldElement, data.error || ('HTTP ' + r.status));
          return;
        }
        window.location.reload();
      });
    }).catch(function () {
      if (fieldElement) showError(fieldElement, 'Could not reset that setting');
    });
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    var key = target.getAttribute('data-key');
    if (!key) return;
    save(key, target.value);
  });

  document.addEventListener('keydown', function (event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (event.key !== 'Enter') return;
    var key = target.getAttribute('data-add');
    if (!key) return;
    event.preventDefault();
    var fieldElement = fieldEl(key);
    if (!fieldElement) return;
    var listEl = fieldElement.querySelector('[data-list="' + key + '"]');
    var current = Array.prototype.map.call(listEl.querySelectorAll('[data-remove]'), function (btn) {
      return btn.getAttribute('data-term');
    });
    var term = target.value.trim();
    if (!term) return;
    save(key, current.concat([term]));
  });

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;

    var removeBtn = target.closest('[data-remove]');
    if (removeBtn) {
      var removeKey = removeBtn.getAttribute('data-remove');
      var fieldElement = fieldEl(removeKey);
      var listEl = fieldElement.querySelector('[data-list="' + removeKey + '"]');
      var current = Array.prototype.map.call(listEl.querySelectorAll('[data-remove]'), function (btn) {
        return btn.getAttribute('data-term');
      }).filter(function (term) { return term !== removeBtn.getAttribute('data-term'); });
      save(removeKey, current);
      return;
    }

    var resetBtn = target.closest('[data-reset]');
    if (resetBtn) {
      reset(resetBtn.getAttribute('data-reset'));
      return;
    }

    var rescoreBtn = target.closest('#rescore');
    if (rescoreBtn) {
      // Irreversible — clearScoresSince deletes real score rows — so make the
      // owner confirm how many are about to be re-judged before it fires.
      if (!window.confirm('Re-judge ' + rescoreBtn.getAttribute('data-count') + ' jobs? Their current scores will be deleted.')) {
        return;
      }
      rescoreBtn.disabled = true;
      rescoreBtn.textContent = 'Rescoring…';
      fetch('/api/rescore', { method: 'POST' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          window.location.reload();
        })
        .catch(function () {
          rescoreBtn.disabled = false;
          rescoreBtn.textContent = 'Rescore failed — try again';
        });
    }
  });
})();
`;
