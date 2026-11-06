import { statusLabel } from '../alerts/format.js';
import { SEVERITY } from '../types.js';
import { ASSET_VERSION } from './assets.js';
import type { CheckView, StatusView } from './view.js';

const MAX_COMPONENTS = 5;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) URLs become links; anything else is rendered as plain text by callers. */
function safeUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function fmtTime(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'never';
}

/** Clock only, for dense spots; the full stamp goes in a title attribute. */
function fmtClock(iso: string | null): string {
  return iso ? `${iso.slice(11, 16)} UTC` : 'never';
}

/** Worst first; unknown (unreachable) sits between degraded and partial outage. */
function bySeverity(a: CheckView, b: CheckView): number {
  const rank = (s: CheckView['status']) => (s === 'unknown' ? 2.5 : SEVERITY[s]);
  return rank(b.status) - rank(a.status);
}

function vendorName(c: CheckView): string {
  const page = safeUrl(c.pageUrl);
  return page
    ? `<a href="${esc(page)}" rel="noopener noreferrer" title="Open the vendor's status page">${esc(c.name)}</a>`
    : esc(c.name);
}

function strip(c: CheckView): string {
  if (c.history.length === 0) return '';
  const squares = c.history
    .map((h) => {
      const label = h.status ? statusLabel(h.status) : 'No data';
      const attr = h.status ? ` data-status="${esc(h.status)}"` : '';
      return `<span${attr} title="${esc(`${h.day}: ${label}`)}"></span>`;
    })
    .join('');
  return `<div class="strip" aria-label="Last 7 days">${squares}</div>`;
}

/** Full-detail row for a vendor that is not operational. */
function renderAttention(c: CheckView): string {
  const since = c.since ? `<small>since ${esc(fmtTime(c.since))}</small>` : '';
  const what: string[] = [];
  const first = c.incidents[0];
  if (first) {
    const href = safeUrl(first.url);
    const title = href ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(first.title)}</a>` : esc(first.title);
    const more = c.incidents.length > 1 ? ` <span class="more">and ${c.incidents.length - 1} more</span>` : '';
    what.push(`<p class="incident">${title}${more}</p>`);
  }
  if (c.components.length > 0) {
    const shown = c.components.slice(0, MAX_COMPONENTS).map((x) => esc(x.name));
    const extra = c.components.length - shown.length;
    what.push(`<p class="affected">Affected: ${shown.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}</p>`);
  }
  if (c.status === 'unknown' && c.error) what.push(`<p class="error">${esc(c.error)}</p>`);
  if (c.feed === 'none') what.push('<p class="ping">No public status feed. Checked with an HTTP ping.</p>');

  return `<li class="row" id="${esc(c.id)}" data-status="${esc(c.status)}">
<span class="rail" aria-hidden="true"></span>
<div class="who"><h2>${vendorName(c)}</h2><span class="state">${esc(c.label)}${since}</span></div>
<div class="what">${what.join('')}</div>
<div class="when">${strip(c)}<div title="${esc(fmtTime(c.checkedAt))}">Checked ${esc(fmtClock(c.checkedAt))}</div></div>
</li>`;
}

/** Compact tile for an operational vendor. */
function renderTile(c: CheckView): string {
  const ping = c.feed === 'none' ? '<span class="ping" title="No public status feed; checked with an HTTP ping">ping</span>' : '';
  return `<li class="tile" id="${esc(c.id)}" data-status="operational" title="${esc(`Checked ${fmtTime(c.checkedAt)}`)}">
<div class="head"><h2>${vendorName(c)}</h2>${ping}</div>
${strip(c)}
</li>`;
}

function headline(v: StatusView): { text: string; tone: 'neutral' | 'ok' | 'bad' | 'maintenance' } {
  if (v.awaitingFirstPoll) return { text: 'Awaiting first poll', tone: 'neutral' };
  const parts: string[] = [];
  if (v.issues > 0) parts.push(`${v.issues} need attention`);
  if (v.maintenance > 0) parts.push(`${v.maintenance} in maintenance`);
  if (parts.length === 0) return { text: 'All systems operational', tone: 'ok' };
  return { text: parts.join(' · '), tone: v.issues > 0 ? 'bad' : 'maintenance' };
}

function summary(v: StatusView): string {
  const n = v.checks.length;
  const vendors = `${n} ${n === 1 ? 'vendor' : 'vendors'}`;
  if (v.awaitingFirstPoll) return `${vendors} configured. The first results arrive after the next poll.`;
  const fine = n - v.issues - v.maintenance;
  const detail = fine === n ? `${vendors} watched` : `${vendors}, ${fine} operational`;
  return `${detail}. Checked ${fmtTime(v.generatedAt)}.`;
}

export function renderDashboard(v: StatusView, basePath: string): string {
  const overall = headline(v);
  const l = v.liveness;
  const bp = esc(basePath);
  const attention = v.checks.filter((c) => c.status !== 'operational').sort(bySeverity);
  const healthy = v.checks.filter((c) => c.status === 'operational');
  const sections: string[] = [];
  if (attention.length > 0) sections.push(`<ul class="ledger">\n${attention.map(renderAttention).join('\n')}\n</ul>`);
  if (healthy.length > 0) {
    const heading = attention.length > 0 ? `<h3 class="group">Operational</h3>` : '';
    sections.push(`${heading}<ul class="tiles">\n${healthy.map(renderTile).join('\n')}\n</ul>`);
  }
  const poller = v.healthy
    ? `Polling every ${esc(String(l.intervalSeconds))} seconds. Last cycle finished ${esc(fmtTime(l.lastCycleCompletedAt))}.`
    : l.lastCycleCompletedAt === null
      ? `Polling every ${esc(String(l.intervalSeconds))} seconds. No cycle has completed yet.`
      : `<span class="stalled">Poller stalled.</span> Last cycle finished ${esc(fmtTime(l.lastCycleCompletedAt))}; expected one every ${esc(String(l.intervalSeconds))} seconds.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="color-scheme" content="light dark">
<title>Inspra vendor status</title>
<link rel="icon" href="${bp}/assets/favicon.svg?v=${ASSET_VERSION}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="${bp}/assets/app.css?v=${ASSET_VERSION}">
</head>
<body>
<header class="wrap">
<p class="brand">Inspra vendor status</p>
<div class="overall ${overall.tone}">${esc(overall.text)}</div>
<p class="summary">${esc(summary(v))}</p>
</header>
<main class="wrap">
${sections.join('\n')}
</main>
<footer class="wrap">
<p>${poller} Reloads every minute.</p>
<p><a href="${bp}/api/status">JSON</a><a href="${bp}/healthz">Health</a></p>
</footer>
</body>
</html>
`;
}
