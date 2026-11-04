import type { Incident, Status } from '../types.js';
import type { AlertEvent } from './decide.js';

const LABELS: Record<Status, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Maintenance',
  unknown: 'Unknown',
};

const EMOJI: Record<Status, string> = {
  operational: ':large_green_circle:',
  degraded: ':large_orange_circle:',
  partial_outage: ':red_circle:',
  major_outage: ':red_circle:',
  maintenance: ':large_blue_circle:',
  unknown: ':white_circle:',
};

const MAX_INCIDENTS = 5;
const MAX_COMPONENTS = 10;
const MAX_ERROR = 500;
const MAX_TITLE = 200;
const MAX_NAME = 100;
const MAX_URL = 500;
const MAX_BLOCK_TEXT = 2900; // Slack section/context text limit is 3000

export function statusLabel(s: Status): string {
  return LABELS[s];
}

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Code-point safe: never splits a surrogate pair. */
function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…';
}

/**
 * Joins whole, already-escaped parts while the running length stays within the
 * budget; dropped parts are summarised as "…and N more". Never cuts a part.
 */
function fitParts(parts: string[], sep: string, budget: number): string {
  const reserve = 20;
  let out = '';
  let used = 0;
  for (const p of parts) {
    const next = used === 0 ? p : out + sep + p;
    if (used > 0 && next.length > budget - reserve) break;
    out = next;
    used += 1;
  }
  const dropped = parts.length - used;
  return dropped > 0 ? `${out}${used > 0 ? sep : ''}…and ${dropped} more` : out;
}

const HTTP_URL = /^https?:\/\//i;
const UNSAFE_IN_LINK = /[<>|\s]/;

function safeUrl(u: string | undefined): string | undefined {
  if (!u || u.length > MAX_URL || !HTTP_URL.test(u) || UNSAFE_IN_LINK.test(u)) return undefined;
  return u;
}

function buildHeadline(e: AlertEvent, esc: (s: string) => string): string {
  const emoji = e.kind === 'recovered' ? ':large_green_circle:' : EMOJI[e.to];
  const name = esc(truncate(e.checkName, MAX_NAME));
  switch (e.kind) {
    case 'recovered':
      return `${emoji} ${name} recovered (was ${statusLabel(e.from ?? 'unknown')})`;
    case 'unreachable':
      return `${emoji} ${name}: status unavailable`;
    case 'new_incident':
      return `${emoji} ${name}: new incident`;
    case 'reminder':
      return `${emoji} Reminder: ${name} still ${statusLabel(e.to)} since ${e.since}`;
    default:
      return `${emoji} ${name}: ${statusLabel(e.to)}`;
  }
}

export function headline(e: AlertEvent): string {
  return buildHeadline(e, (x) => x);
}

function dashboardUrl(e: AlertEvent, appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/#${e.checkId}`;
}

function slackIncidentLine(i: Incident): string {
  const label = escapeMrkdwn(truncate(i.title, MAX_TITLE)).replace(/\|/g, '¦');
  const url = safeUrl(i.url);
  return `${url ? `<${url}|${label}>` : label} (${statusLabel(i.status)})`;
}

function plainIncidentLine(i: Incident): string {
  return `${truncate(i.title, MAX_TITLE)} (${statusLabel(i.status)})${i.url ? ` - ${i.url}` : ''}`;
}

export function buildSlackPayload(e: AlertEvent, appUrl: string): { text: string; blocks: unknown[] } {
  const text = buildHeadline(e, escapeMrkdwn);
  // Every part is capped and escaped before it gets here, and whole parts are
  // budgeted, so no text is ever cut mid-entity or mid-link.
  const mrkdwn = (t: string) => ({ type: 'mrkdwn', text: t });
  const blocks: unknown[] = [{ type: 'section', text: mrkdwn(`*${text}*`) }];

  if (e.incidents.length > 0) {
    const lines = e.incidents.slice(0, MAX_INCIDENTS).map((i) => `- ${slackIncidentLine(i)}`);
    blocks.push({ type: 'section', text: mrkdwn(fitParts(lines, '\n', MAX_BLOCK_TEXT)) });
  }

  if (e.components.length > 0) {
    const names = e.components.slice(0, MAX_COMPONENTS).map((c) => escapeMrkdwn(truncate(c.name, MAX_NAME)));
    const prefix = 'Affected: ';
    blocks.push({
      type: 'context',
      elements: [mrkdwn(prefix + fitParts(names, ', ', MAX_BLOCK_TEXT - prefix.length))],
    });
  }

  if (e.kind === 'unreachable' && e.error) {
    blocks.push({ type: 'section', text: mrkdwn(`Error: ${escapeMrkdwn(truncate(e.error, MAX_ERROR))}`) });
  }

  const links: string[] = [];
  const dash = safeUrl(dashboardUrl(e, appUrl));
  if (dash) links.push(`<${dash}|View dashboard>`);
  const page = safeUrl(e.pageUrl);
  if (page) links.push(`<${page}|Vendor status page>`);
  if (links.length > 0) blocks.push({ type: 'section', text: mrkdwn(links.join('  |  ')) });

  return { text, blocks };
}

export function buildEmail(e: AlertEvent, appUrl: string): { subject: string; text: string } {
  const subject = headline(e).replace(/^:[a-z_]+:\s*/, '');
  const lines: string[] = [subject, ''];
  lines.push(`Status: ${statusLabel(e.to)}`, `Since: ${e.since}`, `Detected: ${e.at}`);
  if (e.incidents.length > 0) {
    lines.push('', 'Incidents:');
    for (const i of e.incidents.slice(0, MAX_INCIDENTS)) lines.push(`- ${plainIncidentLine(i)}`);
  }
  if (e.components.length > 0) {
    lines.push('', `Affected components: ${e.components.slice(0, MAX_COMPONENTS).map((c) => c.name).join(', ')}`);
  }
  if (e.kind === 'unreachable' && e.error) lines.push('', `Error: ${truncate(e.error, MAX_ERROR)}`);
  lines.push('', `Dashboard: ${dashboardUrl(e, appUrl)}`);
  if (e.pageUrl) lines.push(`Vendor status page: ${e.pageUrl}`);
  return { subject, text: lines.join('\n') + '\n' };
}
