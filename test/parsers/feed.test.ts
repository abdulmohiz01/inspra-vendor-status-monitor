import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFeed } from '../../src/parsers/feed.js';
import { ParseError } from '../../src/types.js';

const load = (f: string): string => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8');
const aws = load('aws-all.rss');
const vapi = load('betterstack-vapi-feed.rss');
const atom = load('google-workspace-feed.atom');
const open = atom.replace('RESOLVED: ', '').replace('has been resolved', 'is being investigated');

describe('parseFeed', () => {
  it('RSS filter drops non-matching items (ap-southeast-2 is quiet)', () => {
    const r = parseFeed(aws, { now: new Date('2026-11-04T13:30:00Z'), lookbackHours: 24, components: ['ap-southeast-2'] });
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('RSS filter keeps matching items (me-central-1)', () => {
    const r = parseFeed(aws, { now: new Date('2026-09-15T12:00:00Z'), lookbackHours: 24, components: ['me-central-1'] });
    expect(r.status).toBe('partial_outage');
    expect(r.incidents.length).toBeGreaterThanOrEqual(1);
    expect(r.incidents.some((i) => i.title.includes('Service disruption'))).toBe(true);
  });

  it('treats a newest item saying "completed" as resolved', () => {
    const r = parseFeed(vapi, { now: new Date('2026-10-20T09:30:00Z'), lookbackHours: 24 });
    expect(r.incidents.find((i) => i.url === 'https://status.vapi.ai/maintenance/1095047')).toBeUndefined();
  });

  it('flags an in-window maintenance item as maintenance', () => {
    const r = parseFeed(vapi, { now: new Date('2026-10-30T16:00:00Z'), lookbackHours: 24 });
    expect(r.status).toBe('maintenance');
    expect(r.incidents.some((i) => i.url === 'https://status.vapi.ai/maintenance/1108915')).toBe(true);
  });

  it('Atom RESOLVED entry is operational', () => {
    const r = parseFeed(atom, { now: new Date('2026-09-25T17:00:00Z'), lookbackHours: 24 });
    expect(r.status).toBe('operational');
  });

  it('Atom open entry is degraded with a dashboard url', () => {
    const r = parseFeed(open, { now: new Date('2026-09-25T17:00:00Z'), lookbackHours: 24 });
    expect(r.status).toBe('degraded');
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]!.url).toBe('https://www.google.com/appsstatus/dashboard/incidents/BoKRw5LNb3Vb2NadUJRU');
  });

  it('ignores items outside the lookback window', () => {
    const r = parseFeed(open, { now: new Date('2026-09-28T17:00:00Z'), lookbackHours: 24 });
    expect(r.status).toBe('operational');
  });

  it('throws ParseError on malformed XML', () => {
    expect(() => parseFeed('<rss', { now: new Date(), lookbackHours: 24 })).toThrow(ParseError);
  });

  const rss = (items: string): string => `<rss version="2.0"><channel>${items}</channel></rss>`;
  const item = (guid: string, title: string, date: string, desc = ''): string =>
    `<item><title>${title}</title><link>https://x/${guid}</link><guid>${guid}</guid><pubDate>${date}</pubDate><description>${desc}</description></item>`;

  it('treats a future-dated active item as current (clock skew)', () => {
    const xml = rss(item('g1', 'Service disruption in us-east-1', 'Wed, 04 Nov 2026 13:10:00 GMT'));
    const r = parseFeed(xml, { now: new Date('2026-11-04T13:00:00Z'), lookbackHours: 24 });
    expect(r.status).toBe('partial_outage');
    expect(r.incidents).toHaveLength(1);
  });

  it('filters per group: newest resolved item decides even if it lacks the filter term', () => {
    const xml = rss(
      item('g2', 'Resolved: all fine', 'Wed, 04 Nov 2026 12:30:00 GMT', 'recovered') +
        item('g2', 'Service update', 'Wed, 04 Nov 2026 12:00:00 GMT', 'increased error rates in me-central-1'),
    ).replace('Resolved: all fine', 'Issue resolved');
    const r = parseFeed(xml, { now: new Date('2026-11-04T13:00:00Z'), lookbackHours: 24, components: ['me-central-1'] });
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('treats an unparseable date as now (fails closed)', () => {
    const xml = rss(item('g3', 'Service disruption', 'not a date'));
    const r = parseFeed(xml, { now: new Date('2026-11-04T13:00:00Z'), lookbackHours: 24 });
    expect(r.status).toBe('partial_outage');
    expect(r.incidents[0]!.startedAt).toBe('2026-11-04T13:00:00.000Z');
  });
});
