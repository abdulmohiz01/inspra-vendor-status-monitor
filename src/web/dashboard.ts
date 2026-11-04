import { statusLabel } from '../alerts/format.js';
import type { Status } from '../types.js';
import type { CheckView, StatusView } from './view.js';

const COLOURS: Record<Status, string> = {
  operational: '#1a7f37',
  maintenance: '#0969da',
  degraded: '#bf8700',
  partial_outage: '#d1580b',
  major_outage: '#cf222e',
  unknown: '#8c959f',
};
const NO_DATA = '#eaeef2';
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

function renderCard(c: CheckView): string {
  const parts: string[] = [];
  parts.push(
    `<h2>${esc(c.name)} <span class="badge" style="background:${COLOURS[c.status]}">${esc(c.label)}</span></h2>`,
  );
  if (c.since) parts.push(`<p class="muted">since ${esc(fmtTime(c.since))}</p>`);
  parts.push(`<p class="muted">last checked ${esc(fmtTime(c.checkedAt))}</p>`);

  const first = c.incidents[0];
  if (first) {
    const href = safeUrl(first.url);
    const title = href ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(first.title)}</a>` : esc(first.title);
    const more = c.incidents.length > 1 ? ` <span class="muted">+${c.incidents.length - 1} more</span>` : '';
    parts.push(`<p>${title}${more}</p>`);
  }
  if (c.components.length > 0) {
    const shown = c.components.slice(0, MAX_COMPONENTS).map((x) => esc(x.name));
    const extra = c.components.length - shown.length;
    parts.push(`<p class="muted">Affected: ${shown.join(', ')}${extra > 0 ? ` +${extra} more` : ''}</p>`);
  }
  if (c.status === 'unknown' && c.error) parts.push(`<p class="error">${esc(c.error)}</p>`);
  if (c.feed === 'none') parts.push('<p><span class="tag">no public feed — HTTP ping</span></p>');
  const page = safeUrl(c.pageUrl);
  if (page) parts.push(`<p><a href="${esc(page)}" rel="noopener noreferrer">Vendor status page</a></p>`);

  const squares = c.history
    .map((h) => {
      const colour = h.status ? COLOURS[h.status] : NO_DATA;
      const label = h.status ? statusLabel(h.status) : 'No data';
      return `<span style="background:${colour}" title="${esc(`${h.day}: ${label}`)}"></span>`;
    })
    .join('');
  parts.push(`<div class="strip">${squares}</div>`);
  return `<section class="card" id="${esc(c.id)}">${parts.join('')}</section>`;
}

function headline(v: StatusView): { text: string; tone: 'neutral' | 'ok' | 'bad' | 'maintenance' } {
  if (v.awaitingFirstPoll) return { text: 'Awaiting first poll', tone: 'neutral' };
  const parts: string[] = [];
  if (v.issues > 0) parts.push(`${v.issues} need attention`);
  if (v.maintenance > 0) parts.push(`${v.maintenance} in maintenance`);
  if (parts.length === 0) return { text: 'All systems operational', tone: 'ok' };
  return { text: parts.join(' · '), tone: v.issues > 0 ? 'bad' : 'maintenance' };
}

export function renderDashboard(v: StatusView, basePath: string): string {
  const overall = headline(v);
  const l = v.liveness;
  const bp = esc(basePath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Inspra vendor status</title>
<link rel="icon" href="${bp}/assets/favicon.svg">
<link rel="stylesheet" href="${bp}/assets/app.css">
</head>
<body>
<header>
<h1>Inspra vendor status</h1>
<div class="overall ${overall.tone}">${esc(overall.text)}</div>
<div class="muted">Generated ${esc(fmtTime(v.generatedAt))}</div>
</header>
<main>
<div class="grid">
${v.checks.map(renderCard).join('\n')}
</div>
</main>
<footer class="muted">
<div>Poller: last cycle completed ${esc(fmtTime(l.lastCycleCompletedAt))}, every ${esc(String(l.intervalSeconds))}s${v.healthy ? '' : l.lastCycleCompletedAt === null ? ' (awaiting first poll)' : ' (stalled)'}</div>
<div><a href="${bp}/api/status">JSON</a> · <a href="${bp}/healthz">Health</a></div>
</footer>
</body>
</html>
`;
}
