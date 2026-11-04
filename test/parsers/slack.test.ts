import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlack } from '../../src/parsers/slack.js';
import { ParseError } from '../../src/types.js';

const load = (f: string): any => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));

describe('parseSlack', () => {
  it('reports operational with no active incidents', () => {
    const r = parseSlack(load('slack-current.json'), {});
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('maps an active incident to partial_outage with a per-service component', () => {
    const r = parseSlack(load('slack-current-active.json'), {});
    expect(r.status).toBe('partial_outage');
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]).toMatchObject({
      title: 'Slack Real-Time Connection Disruption',
      url: 'https://slack-status.com/2026-10/58a30c7fc8aa3e80',
    });
    expect(r.components).toEqual([{ name: 'Messaging', status: 'partial_outage' }]);
  });

  it('drops incidents that do not touch a filtered service', () => {
    const r = parseSlack(load('slack-current-active.json'), { components: ['Huddles'] });
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('keeps incidents touching a filtered service (case-insensitive)', () => {
    const r = parseSlack(load('slack-current-active.json'), { components: ['messaging'] });
    expect(r.status).toBe('partial_outage');
    expect(r.incidents).toHaveLength(1);
  });

  it('maps incident types and ignores resolved incidents', () => {
    const doc = load('slack-current-active.json');
    const base = doc.active_incidents[0];
    doc.active_incidents = [
      { ...base, id: 1, type: 'outage', services: ['Calls'] },
      { ...base, id: 2, type: 'notice', services: ['Calls', 'Files'] },
      { ...base, id: 3, type: 'outage', status: 'resolved', services: ['Files'] },
    ];
    const r = parseSlack(doc, {});
    expect(r.status).toBe('major_outage');
    expect(r.incidents).toHaveLength(2);
    expect(r.components).toEqual(
      expect.arrayContaining([
        { name: 'Calls', status: 'major_outage' },
        { name: 'Files', status: 'degraded' },
      ]),
    );
  });

  it('merges service names case-insensitively into one component', () => {
    const doc = load('slack-current-active.json');
    const base = doc.active_incidents[0];
    doc.active_incidents = [
      { ...base, id: 1, type: 'notice', services: ['Messaging'] },
      { ...base, id: 2, type: 'outage', services: ['messaging'] },
    ];
    const r = parseSlack(doc, {});
    expect(r.components).toEqual([{ name: 'Messaging', status: 'major_outage' }]);
  });

  it('throws ParseError on a bad shape', () => {
    expect(() => parseSlack({ nope: true }, {})).toThrow(ParseError);
  });
});
