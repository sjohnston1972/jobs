/**
 * Front panel.
 *
 * The organising idea is a type split that encodes provenance: Martian Mono is
 * the silkscreen — every value the pipeline measured (scores, IDs, bands,
 * counts). Inter Tight is human text — titles, employers, the model's reason,
 * the quoted evidence. If it is printed on the panel it is mono; if someone
 * wrote it, it is not.
 */
export const STYLES = /* css */ `
:root {
  --bg:        #0A1113;
  --panel:     #111B1F;
  --panel-hi:  #16242A;
  --well:      #0B1416;
  --rule:      #23343A;
  --rule-soft: #1A272C;
  --text:      #E6F0F2;
  --dim:       #7F979F;
  --dimmer:    #5B7178;
  --accent:    #FF7A66;
  --accent-dk: #E35F4A;

  --sig-high:  #4FD1A5;
  --sig-mid:   #E8B94A;
  --sig-low:   #6E8790;
  --sig-fail:  #FF7A66;

  --unit-r: 3px;
  --gap: 14px;
  --shell: 1180px;

  --mono: 'Martian Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: 'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg:        #EEF2F2;
    --panel:     #FFFFFF;
    --panel-hi:  #F6F9F9;
    --well:      #F0F4F4;
    --rule:      #D3DEE0;
    --rule-soft: #E4EBEC;
    --text:      #0E1A1E;
    --dim:       #566A71;
    --dimmer:    #7B8F96;
    --accent:    #C4432C;
    --accent-dk: #A5341F;

    --sig-high:  #0F8A63;
    --sig-mid:   #976A05;
    --sig-low:   #6E8790;
    --sig-fail:  #C4432C;
  }
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); text-decoration: none; }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.shell {
  max-width: var(--shell);
  margin: 0 auto;
  padding: 0 20px 80px;
}

/* ---------------------------------------------------------- title block
   Borrowed from the title block on a drawing sheet: identity on the left,
   the measured facts on the right, one heavy rule under both. */

.masthead {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 34px 0 16px;
  border-bottom: 2px solid var(--text);
}

.brand__name {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  margin: 0;
}

.brand__sub {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--dimmer);
  margin-top: 7px;
}

.readouts {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  border: 1px solid var(--rule);
  border-radius: var(--unit-r);
  overflow: hidden;
  background: var(--panel);
}

.readout {
  padding: 7px 15px;
  border-right: 1px solid var(--rule);
  min-width: 74px;
}
.readout:last-child { border-right: 0; }

.readout__value {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 17px;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.readout__label {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--dimmer);
  margin-top: 4px;
}

.readout--live .readout__value { color: var(--sig-high); }
.readout--warn .readout__value { color: var(--sig-mid); }

/* ---------------------------------------------------------- control strip */

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 22px;
}

.search {
  flex: 1 1 220px;
  min-width: 180px;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: var(--unit-r);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  padding: 9px 12px;
}
.search::placeholder { color: var(--dimmer); letter-spacing: 0.04em; }
.search:focus { border-color: var(--accent); outline: none; }

/* Filter disclosure. Desktop shows every chipset inline; on a phone fourteen
   chips would fill the first screen before a single job appeared, so they
   collapse behind a toggle. Checkbox rather than <details> so it works with
   no JS and the desktop layout is a plain CSS override. */

/* visibility:hidden keeps the control out of the tab order and off the
   accessibility tree on desktop, where the panel is always open and the toggle
   is not rendered. The mobile breakpoint switches it back on. */
.filters__check {
  position: absolute;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}

.filters__toggle {
  display: none;
  align-items: center;
  gap: 7px;
  padding: 0 13px;
  border: 1px solid var(--rule);
  border-radius: var(--unit-r);
  background: var(--panel);
  color: var(--dim);
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
}
.filters__check:focus-visible + .filters__toggle {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.filters__toggle::after { content: '+'; font-size: 13px; line-height: 1; }
.filters__check:checked + .filters__toggle::after { content: '–'; }
.filters__check:checked + .filters__toggle {
  border-color: var(--accent);
  color: var(--accent);
}

/* Count of applied filters, so a collapsed panel never hides that a view is filtered. */
.filters__count {
  display: inline-block;
  min-width: 16px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--accent);
  color: #12070A;
  font-size: 9px;
  font-weight: 700;
}

.filters__body {
  display: contents;
}

.chipset { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

.chipset__label {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--dimmer);
  margin-right: 2px;
}

.chip {
  display: inline-block;
  padding: 6px 11px;
  border: 1px solid var(--rule);
  border-radius: var(--unit-r);
  background: var(--panel);
  color: var(--dim);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color .12s ease, color .12s ease, background .12s ease;
}
.chip[aria-pressed="true"] {
  background: var(--accent);
  border-color: var(--accent);
  color: #12070A;
  font-weight: 700;
}

/* ---------------------------------------------------------- the stack */

.stack { display: flex; flex-direction: column; gap: var(--gap); }

.unit {
  background: var(--panel);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--band, var(--sig-low));
  border-radius: var(--unit-r);
  overflow: hidden;
}

.unit__face {
  display: grid;
  grid-template-columns: 72px 1fr auto;
  align-items: start;
  gap: 18px;
  padding: 16px 18px;
}

/* -- score well: recessed, tabular, the one big number on the panel */

.well {
  background: var(--well);
  border: 1px solid var(--rule-soft);
  border-radius: 2px;
  padding: 9px 6px 8px;
  text-align: center;
}

.well__score {
  font-family: var(--mono);
  font-weight: 800;
  font-size: 25px;
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  color: var(--band, var(--sig-low));
}

.well__band {
  font-family: var(--mono);
  font-size: 7.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dimmer);
  margin-top: 5px;
}

/* -- confidence meter: three segments, lit to the level. A dot would say
      "there is a value here"; segments say how much. */

.meter {
  display: flex;
  gap: 2px;
  justify-content: center;
  margin-top: 7px;
}

.meter__seg {
  width: 11px;
  height: 3px;
  border-radius: 1px;
  background: var(--rule);
}
.meter__seg--lit { background: var(--band, var(--sig-low)); }

.unit__body { min-width: 0; }

.unit__title {
  font-family: var(--sans);
  font-weight: 620;
  font-size: 16.5px;
  line-height: 1.3;
  letter-spacing: -0.011em;
  margin: 0;
}
.unit__title a { color: var(--text); }
.unit__title { overflow-wrap: anywhere; }

.unit__employer {
  font-family: var(--sans);
  font-size: 14px;
  color: var(--dim);
  margin-top: 2px;
}

.specs {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 11px;
}

.spec {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--dim);
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 3px 7px;
  white-space: nowrap;
}
.spec--flag  { color: var(--sig-fail); border-color: color-mix(in srgb, var(--sig-fail) 40%, transparent); }
.spec--good  { color: var(--sig-high); border-color: color-mix(in srgb, var(--sig-high) 40%, transparent); }
.spec--est   { color: var(--dimmer); font-style: normal; }

/* -- evidence capture: the phrase that decided the remote judgement.
      This field is what makes the whole thing trustworthy over time, so it
      gets its own recessed strip rather than being another spec chip. */

.capture {
  margin: 13px 0 0;
  padding: 10px 13px;
  background: var(--well);
  border-left: 2px solid var(--band, var(--sig-low));
  border-radius: 0 2px 2px 0;
  font-family: var(--sans);
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text);
}
.capture--missing {
  border-left-color: var(--sig-fail);
  color: var(--dim);
  font-size: 13px;
}
.capture__tag {
  display: block;
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dimmer);
  margin-bottom: 5px;
}

.reason {
  margin-top: 11px;
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--dim);
}

/* -- action cluster, right edge of the unit */

.actions {
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: stretch;
  min-width: 116px;
}

.btn {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  padding: 7px 10px;
  border: 1px solid var(--rule);
  border-radius: 2px;
  background: var(--panel-hi);
  color: var(--dim);
  cursor: pointer;
  text-align: center;
  transition: border-color .12s ease, color .12s ease, background .12s ease;
}
.btn:disabled { opacity: .5; cursor: default; }

.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #12070A;
  font-weight: 700;
}

.btn--on {
  background: color-mix(in srgb, var(--sig-high) 16%, transparent);
  border-color: var(--sig-high);
  color: var(--sig-high);
  font-weight: 700;
}

.statusbar {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.statusbar .btn { flex: 1 1 auto; padding: 6px 8px; font-size: 9px; }

/* -- expandable detail drawer */

.drawer {
  display: none;
  padding: 16px 18px 20px;
  border-top: 1px solid var(--rule);
  background: var(--panel-hi);
}
.unit[data-open="true"] .drawer { display: block; }

.drawer__label {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--dimmer);
  margin: 0 0 8px;
}

.drawer__text {
  font-size: 14px;
  line-height: 1.65;
  color: var(--dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 340px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-right: 8px;
}

.drawer__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--rule);
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--dimmer);
}

/* ---------------------------------------------------------- empty + notice */

.empty {
  border: 1px dashed var(--rule);
  border-radius: var(--unit-r);
  padding: 52px 24px;
  text-align: center;
}
.empty__title { font-size: 17px; font-weight: 600; }
.empty__body { color: var(--dim); margin-top: 8px; font-size: 14.5px; }

.notice {
  border: 1px solid var(--rule);
  border-left: 3px solid var(--sig-mid);
  border-radius: var(--unit-r);
  background: var(--panel);
  padding: 13px 16px;
  margin-bottom: 20px;
  font-size: 14px;
  color: var(--dim);
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translate(-50%, 14px);
  background: var(--panel-hi);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--sig-high);
  border-radius: var(--unit-r);
  padding: 11px 17px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text);
  opacity: 0;
  pointer-events: none;
  transition: opacity .16s ease, transform .16s ease;
  z-index: 40;
}
.toast[data-show="true"] { opacity: 1; transform: translate(-50%, 0); }
.toast[data-kind="error"] { border-left-color: var(--sig-fail); }

/* ---------------------------------------------------------- footer */

.footer {
  margin-top: 44px;
  padding-top: 18px;
  border-top: 1px solid var(--rule);
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dimmer);
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  justify-content: space-between;
}

/* ---------------------------------------------------------- prose pages */

.prose { max-width: 760px; margin: 0 auto; padding: 44px 20px 80px; }
.prose h1 { font-family: var(--mono); font-size: 17px; letter-spacing: 0.09em; text-transform: uppercase; }
.prose h2 {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--dimmer);
  margin: 34px 0 10px; padding-bottom: 8px; border-bottom: 1px solid var(--rule);
}
.prose pre {
  background: var(--panel); border: 1px solid var(--rule); border-radius: var(--unit-r);
  padding: 16px; overflow-x: auto; font-family: var(--mono); font-size: 12px; line-height: 1.7;
  white-space: pre-wrap; color: var(--dim);
}

/* ---------------------------------------------------------- the one moment
   A link-state sweep down the stack on load. One orchestrated reveal, not
   scattered effects, and it never delays interaction. */

@keyframes unit-in {
  from { opacity: 0; transform: translateY(7px); }
  to   { opacity: 1; transform: none; }
}

.stack .unit {
  animation: unit-in .34s cubic-bezier(.2,.7,.3,1) backwards;
  animation-delay: calc(var(--i, 0) * 32ms);
}

@media (prefers-reduced-motion: reduce) {
  .stack .unit { animation: none; }
  * { transition-duration: .01ms !important; }
}

/* ---------------------------------------------------------- pointer + hover
   Hover styling is opt-in. On a touchscreen :hover latches after a tap and
   leaves buttons looking permanently focused. */

@media (hover: hover) {
  a:hover { text-decoration: underline; }
  .chip:hover { color: var(--text); border-color: var(--dimmer); text-decoration: none; }
  .btn:hover { color: var(--text); border-color: var(--dimmer); text-decoration: none; }
  .btn--primary:hover { background: var(--accent-dk); border-color: var(--accent-dk); color: #fff; }
  .unit__title a:hover { color: var(--accent); text-decoration: none; }
  .filters__toggle:hover { color: var(--text); border-color: var(--dimmer); }
}

/* Touch targets. The panel aesthetic wants small silkscreen type, but a 25px
   button is not tappable — so the label stays small and the hit area grows. */

@media (pointer: coarse) {
  .btn,
  .chip,
  .filters__toggle {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .statusbar .btn { min-height: 44px; padding: 6px 4px; }
  .search { min-height: 44px; }
  .unit__title a { display: inline-block; padding: 2px 0; }
}

/* ---------------------------------------------------------- responsive */

@media (max-width: 860px) {
  .shell {
    padding-left: max(16px, env(safe-area-inset-left));
    padding-right: max(16px, env(safe-area-inset-right));
    padding-bottom: calc(64px + env(safe-area-inset-bottom));
  }

  .masthead { padding: 22px 0 14px; gap: 16px; }
  .brand__sub { font-size: 10px; line-height: 1.6; }

  /* Six readouts wrap into an ugly 4+2 at this width; a fixed 3-column grid
     keeps them aligned and readable. */
  .readouts { width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); }
  .readout { min-width: 0; padding: 9px 10px; border-bottom: 1px solid var(--rule); }
  .readout:nth-child(3n) { border-right: 0; }
  .readout:nth-last-child(-n + 3) { border-bottom: 0; }
  .readout__value { font-size: 16px; }
  .readout__label { font-size: 9px; letter-spacing: 0.08em; }

  .controls { gap: 10px; padding: 14px 0; }
  .search {
    flex: 1 1 auto;
    /* iOS zooms the whole page when a focused input is under 16px. */
    font-size: 16px;
    padding: 10px 12px;
  }
  .controls > .btn { flex: 0 0 auto; }

  .filters__check { visibility: visible; }
  .filters__toggle { display: inline-flex; }
  .filters__body {
    display: none;
    flex-basis: 100%;
    flex-direction: column;
    gap: 12px;
    padding-top: 4px;
  }
  .filters__check:checked ~ .filters__body { display: flex; }
  .chipset { gap: 8px; }
  .chipset__label { font-size: 9.5px; flex-basis: 100%; margin: 0 0 2px; }
  .chip { font-size: 11px; padding: 8px 13px; }

  .unit__face { grid-template-columns: 56px 1fr; gap: 14px; padding: 15px 15px 16px; }
  .well__score { font-size: 21px; }
  .well__band { font-size: 8.5px; }
  .meter__seg { width: 10px; height: 4px; }

  .unit__title { font-size: 16px; }
  .spec { font-size: 10.5px; padding: 4px 8px; }
  .capture { font-size: 14px; }
  .reason { font-size: 14.5px; }

  /* Actions become a full-width block under the body: primary action alone on
     its row, then secondary, then status. Thumb order, not desktop order. */
  .actions {
    grid-column: 1 / -1;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
    margin-top: 2px;
  }
  .actions .btn { flex: 1 1 auto; font-size: 11px; }
  .actions > .btn--primary { flex-basis: 100%; }
  .statusbar { flex-basis: 100%; gap: 6px; }
  .statusbar .btn { flex: 1 1 0; font-size: 10px; letter-spacing: 0.03em; }

  .drawer { padding: 15px 15px 18px; }
  .drawer__text { max-height: 260px; font-size: 14px; }
  .drawer__meta { gap: 10px 16px; font-size: 10px; }

  .footer { font-size: 10.5px; gap: 10px; line-height: 1.7; }
  .toast { bottom: calc(18px + env(safe-area-inset-bottom)); font-size: 11px; }
  .prose { padding: 32px 18px 64px; }
  .prose pre { font-size: 12.5px; padding: 14px; }
}

@media (max-width: 400px) {
  .shell { padding-left: max(12px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right)); }
  .unit__face { grid-template-columns: 50px 1fr; gap: 11px; padding: 14px 12px 15px; }
  .well { padding: 8px 4px 7px; }
  .well__score { font-size: 19px; }
  .meter__seg { width: 8px; }
  .unit__title { font-size: 15.5px; }
  .readout { padding: 8px 7px; }
  .readout__value { font-size: 15px; }
  .readout__label { font-size: 8.5px; letter-spacing: 0.06em; }
  .statusbar .btn { font-size: 9.5px; padding: 6px 2px; }
}
`;
