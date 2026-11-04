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

export function statusLabel(s: Status): string {
  return LABELS[s];
}

export function headline(e: AlertEvent): string {
  const emoji = e.kind === 'recovered' ? ':large_green_circle:' : EMOJI[e.to];
  switch (e.kind) {
    case 'recovered':
      return `${emoji} ${e.checkName} recovered (was ${e.from ? statusLabel(e.from) : 'unknown'})`;
    case 'unreachable':
      return `${emoji} ${e.checkName}: status unavailable`;
    case 'new_incident':
      return `${emoji} ${e.checkName}: new incident`;
    case 'reminder':
      return `${emoji} Reminder: ${e.checkName} still ${statusLabel(e.to)} since ${e.since}`;
    default:
      return `${emoji} ${e.checkName}: ${statusLabel(e.to)}`;
  }
}

function dashboardUrl(e: AlertEvent, appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/#${e.checkId}`;
}

function incidentLine(i: Incident): string {
  const title = i.url ? `<${i.url}|${i.title}>` : i.title;
  return `${title} (${statusLabel(i.status)})`;
}

function plainIncidentLine(i: Incident): string {
  return `${i.title} (${statusLabel(i.status)})${i.url ? ` - ${i.url}` : ''}`;
}

export function buildSlackPayload(e: AlertEvent, appUrl: string): { text: string; blocks: unknown[] } {
  const text = headline(e);
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `*${text}*` } }];

  if (e.incidents.length > 0) {
    const lines = e.incidents.slice(0, MAX_INCIDENTS).map((i) => `- ${incidentLine(i)}`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  }

  if (e.components.length > 0) {
    const names = e.components.slice(0, MAX_COMPONENTS).map((c) => c.name);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Affected: ${names.join(', ')}` }],
    });
  }

  if (e.kind === 'unreachable' && e.error) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Error: ${e.error}` } });
  }

  const links = [`<${dashboardUrl(e, appUrl)}|View dashboard>`];
  if (e.pageUrl) links.push(`<${e.pageUrl}|Vendor status page>`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: links.join('  |  ') } });

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
  if (e.kind === 'unreachable' && e.error) lines.push('', `Error: ${e.error}`);
  lines.push('', `Dashboard: ${dashboardUrl(e, appUrl)}`);
  if (e.pageUrl) lines.push(`Vendor status page: ${e.pageUrl}`);
  return { subject, text: lines.join('\n') + '\n' };
}
