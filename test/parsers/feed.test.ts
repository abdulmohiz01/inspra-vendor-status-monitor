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

  const awsGuid = (ts: number): string => `https://status.aws.amazon.com/#ec2-ap-southeast-2_${ts}`;

  it('groups AWS updates by service-region: a newer [RESOLVED] item supersedes earlier updates', () => {
    const xml = rss(
      item(awsGuid(1793800800), '[RESOLVED] Increased API error rates', 'Wed, 04 Nov 2026 12:40:00 GMT', 'ap-southeast-2 recovered') +
        item(awsGuid(1793799000), 'Increased API error rates', 'Wed, 04 Nov 2026 12:10:00 GMT', 'still investigating in ap-southeast-2') +
        item(awsGuid(1793797200), 'Increased API error rates', 'Wed, 04 Nov 2026 11:40:00 GMT', 'investigating in ap-southeast-2'),
    );
    const r = parseFeed(xml, { now: new Date('2026-11-04T13:00:00Z'), lookbackHours: 24, components: ['ap-southeast-2'] });
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('groups unresolved AWS updates into one incident: the newest', () => {
    const xml = rss(
      item(awsGuid(1793797200), 'Increased API error rates', 'Wed, 04 Nov 2026 11:40:00 GMT', 'investigating in ap-southeast-2') +
        item(awsGuid(1793799000), 'Service disruption: API errors', 'Wed, 04 Nov 2026 12:10:00 GMT', 'ap-southeast-2 impact'),
    );
    const r = parseFeed(xml, { now: new Date('2026-11-04T13:00:00Z'), lookbackHours: 24, components: ['ap-southeast-2'] });
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]).toMatchObject({
      id: 'https://status.aws.amazon.com/#ec2-ap-southeast-2',
      title: 'Service disruption: API errors',
      startedAt: '2026-11-04T12:10:00.000Z',
    });
    expect(r.status).toBe('partial_outage');
  });

  // The fixture was fetched months later. Parsing all of it at a past `now` would clamp later items
  // to `now` (the clock-skew rule) and pull future updates into the window, so slice it to the feed
  // as it stood at `now`.
  const feedAsOf = (now: Date): string =>
    aws.replace(/<item>[\s\S]*?<\/item>/g, (it) => {
      const pub = Date.parse(/<pubDate>([^<]*)<\/pubDate>/.exec(it)?.[1] ?? '');
      return pub > now.getTime() ? '' : it;
    });

  it('groups the real AWS me-central-1 updates into one incident', () => {
    const now = new Date('2026-03-02T18:00:00Z');
    const r = parseFeed(feedAsOf(now), { now, lookbackHours: 24, components: ['me-central-1'] });
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]).toMatchObject({
      id: 'https://status.aws.amazon.com/#multipleservices-me-central-1',
      startedAt: '2026-03-02T17:59:49.000Z',
    });
  });

  it('also counts another region\'s event once its update names the filtered region', () => {
    // At 2026-03-03T00:22:31Z AWS posted a me-south-1 update that says it affects ME-CENTRAL-1 too.
    // From then on, a me-central-1 filter correctly sees two events: its own and the joint one.
    const now = new Date('2026-03-03T01:00:00Z');
    const r = parseFeed(feedAsOf(now), { now, lookbackHours: 24, components: ['me-central-1'] });
    expect(r.incidents.map((i) => i.id).sort()).toEqual([
      'https://status.aws.amazon.com/#multipleservices-me-central-1',
      'https://status.aws.amazon.com/#multipleservices-me-south-1',
    ]);
  });

  it('treats an unparseable date as now (fails closed)', () => {
    const xml = rss(item('g3', 'Service disruption', 'not a date'));
    const r = parseFeed(xml, { now: new Date('2026-11-04T13:00:00Z'), lookbackHours: 24 });
    expect(r.status).toBe('partial_outage');
    expect(r.incidents[0]!.startedAt).toBe('2026-11-04T13:00:00.000Z');
  });
});
