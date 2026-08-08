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
a:hover { text-decoration: underline; }

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
.chip:hover { color: var(--text); border-color: var(--dimmer); text-decoration: none; }
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
.unit__title a:hover { color: var(--accent); text-decoration: none; }

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
.btn:hover { color: var(--text); border-color: var(--dimmer); text-decoration: none; }
.btn:disabled { opacity: .5; cursor: default; }

.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #12070A;
  font-weight: 700;
}
.btn--primary:hover { background: var(--accent-dk); border-color: var(--accent-dk); color: #fff; }

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
  max-height: 340px;
  overflow-y: auto;
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

/* ---------------------------------------------------------- responsive */

@media (max-width: 860px) {
  .unit__face { grid-template-columns: 58px 1fr; gap: 14px; }
  .actions {
    grid-column: 1 / -1;
    flex-direction: row;
    flex-wrap: wrap;
    min-width: 0;
  }
  .actions .btn { flex: 1 1 90px; }
  .well__score { font-size: 21px; }
  .masthead { padding-top: 24px; }
  .readouts { width: 100%; }
  .readout { flex: 1 1 auto; min-width: 62px; }
}

@media (max-width: 520px) {
  .shell { padding: 0 14px 60px; }
  .unit__title { font-size: 15.5px; }
  .readout { padding: 6px 10px; }
  .readout__value { font-size: 15px; }
}
`;
