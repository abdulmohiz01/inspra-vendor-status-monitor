import { createHash } from 'node:crypto';

export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#15202b"/><circle cx="8" cy="8" r="4" fill="#2bb673"/></svg>';

export const APP_CSS = `
:root {
  --bg: #eef1f4;
  --surface: #ffffff;
  --ink: #15202b;
  --ink-2: #5b6774;
  --line: #d6dce3;
  --empty: #dfe4ea;
  --focus: #2b5ec9;
  --ok: #157f5a;
  --maintenance: #2b5ec9;
  --degraded: #b8800a;
  --partial: #d4601c;
  --major: #c8323b;
  --unknown: #7a8591;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f151b;
    --surface: #182028;
    --ink: #eef1f4;
    --ink-2: #93a0ad;
    --line: #2a343f;
    --empty: #27313b;
    --focus: #6f9bff;
    --ok: #2bb673;
    --maintenance: #6f9bff;
    --degraded: #e0a824;
    --partial: #f07f3a;
    --major: #f0545e;
    --unknown: #8d99a6;
  }
}

* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  color: var(--ink);
  background: var(--bg);
  font: 15px/1.45 "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  font-feature-settings: "tnum";
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 2px; }

.wrap { width: 100%; max-width: 1200px; margin: 0 auto; padding-left: 24px; padding-right: 24px; }
main.wrap { flex: 1; }

/* Header: the headline is the page. */
header { padding-top: 32px; padding-bottom: 20px; }
.brand { color: var(--ink-2); font-weight: 500; margin: 0 0 10px; }
.overall {
  margin: 0;
  font-size: clamp(30px, 4.5vw, 52px);
  font-weight: 700;
  line-height: 1.02;
  letter-spacing: -0.025em;
  text-wrap: balance;
}
.overall.ok { color: var(--ok); }
.overall.bad { color: var(--major); }
.overall.maintenance { color: var(--maintenance); }
.overall.neutral { color: var(--ink-2); }
.summary { margin: 10px 0 0; color: var(--ink-2); }

/* Status colours, shared by rows, tiles and history squares. */
[data-status="operational"] { --status: var(--ok); }
[data-status="maintenance"] { --status: var(--maintenance); }
[data-status="degraded"] { --status: var(--degraded); }
[data-status="partial_outage"] { --status: var(--partial); }
[data-status="major_outage"] { --status: var(--major); }
[data-status="unknown"] { --status: var(--unknown); }

/* Attention ledger: one full-width row per vendor with a problem. */
.ledger { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.row {
  display: grid;
  grid-template-columns: 4px minmax(150px, 1fr) minmax(0, 2.4fr) auto;
  gap: 0 20px;
  align-items: start;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
  scroll-margin-top: 20px;
}
.rail { width: 4px; height: 100%; min-height: 40px; border-radius: 2px; background: var(--status); }
.who h2 { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.3; }
.who h2 a, .tile h2 a { text-decoration: none; }
.who h2 a:hover, .tile h2 a:hover { text-decoration: underline; }
.who .state { display: block; color: var(--status); font-weight: 600; font-size: 14px; margin-top: 1px; }
.who .state small { display: block; color: var(--ink-2); font-weight: 400; font-size: 13px; }
.what { min-width: 0; font-size: 14px; }
.what p { margin: 0; }
.what p + p { margin-top: 3px; }
.what .incident { font-weight: 500; }
.what .more, .what .affected, .what .ping { color: var(--ink-2); }
.what .error { color: var(--major); word-break: break-word; }
.when { text-align: right; font-size: 13px; color: var(--ink-2); white-space: nowrap; }
.when .strip { justify-content: flex-end; margin-bottom: 5px; }

/* Healthy tiles: name and a week of history, nothing else. */
.group { margin: 18px 0 8px; font-size: 13px; font-weight: 500; color: var(--ink-2); }
.tiles {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
}
.ledger + .tiles, .group + .tiles { margin-top: 0; }
.tile {
  background: var(--surface);
  border: 1px solid var(--line);
  border-left: 4px solid var(--status);
  border-radius: 4px;
  padding: 9px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  scroll-margin-top: 20px;
}
.tile .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.tile h2 { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
.tile .ping { color: var(--ink-2); font-weight: 400; font-size: 12px; }

.strip { display: flex; gap: 3px; }
.strip span { width: 11px; height: 18px; border-radius: 2px; background: var(--empty); }
.strip span[data-status] { background: var(--status); }

:target { outline: 2px solid var(--focus); outline-offset: 4px; }

footer { padding-top: 18px; padding-bottom: 20px; color: var(--ink-2); font-size: 13px; }
footer p { margin: 0 0 4px; }
footer .stalled { color: var(--major); font-weight: 600; }
footer a { margin-right: 14px; }

@media (max-width: 720px) {
  .wrap { padding-left: 16px; padding-right: 16px; }
  header { padding-top: 24px; padding-bottom: 16px; }
  .row { grid-template-columns: 4px 1fr; gap: 6px 12px; }
  .rail { grid-row: 1 / span 3; }
  .what, .when { grid-column: 2; }
  .when { text-align: left; }
  .when .strip { justify-content: flex-start; }
  .what:empty { display: none; }
  .tiles { grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .tile { padding: 8px 10px; }
}
`;

/** Changes whenever the inline assets change, so a cached stylesheet never outlives a deploy. */
export const ASSET_VERSION = createHash('sha256').update(APP_CSS).update(FAVICON_SVG).digest('hex').slice(0, 10);
