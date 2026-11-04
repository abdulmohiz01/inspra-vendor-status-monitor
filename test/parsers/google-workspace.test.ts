import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGoogleWorkspace } from '../../src/parsers/google-workspace.js';
import { ParseError } from '../../src/types.js';

const load = (f: string): any => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
const incidents = load('google-workspace-incidents.json');
const products = load('google-workspace-products.json');
const now = new Date('2026-11-04T13:00:00Z');
const filter = ['Gmail', 'Google Calendar'];

function ongoing(): any {
  const c = structuredClone(incidents);
  c.find((i: any) => i.id === 'vagmms1y6yRxwg6RMQZp').end = null;
  return c;
}

describe('parseGoogleWorkspace', () => {
  it('is operational when nothing is ongoing', () => {
    const r = parseGoogleWorkspace(incidents, products, { now, components: filter });
    expect(r.status).toBe('operational');
    expect(r.components).toEqual([
      { name: 'Gmail', status: 'operational' },
      { name: 'Google Calendar', status: 'operational' },
    ]);
  });

  it('keeps an ongoing incident touching the filter', () => {
    const r = parseGoogleWorkspace(ongoing(), products, { now, components: filter });
    expect(r.status).toBe('partial_outage');
    expect(r.incidents).toHaveLength(1);
    expect(r.incidents[0]!.id).toBe('vagmms1y6yRxwg6RMQZp');
    expect(r.incidents[0]!.url).toMatch(/incidents\/vagmms1y6yRxwg6RMQZp$/);
    expect(r.incidents[0]!.title.startsWith('**')).toBe(false);
    expect(r.incidents[0]!.title).toBe('Multiple Workspace Products experiencing Issues.');
    expect(r.components).toEqual([
      { name: 'Gmail', status: 'partial_outage' },
      { name: 'Google Calendar', status: 'partial_outage' },
    ]);
  });

  it('drops ongoing incidents that do not touch the filter', () => {
    const r = parseGoogleWorkspace(ongoing(), products, { now, components: ['Google Keep'] });
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('without a filter, lists products affected by ongoing incidents', () => {
    const r = parseGoogleWorkspace(ongoing(), products, { now });
    expect(r.status).toBe('partial_outage');
    expect(r.components.map((c) => c.name)).toEqual(expect.arrayContaining(['Gmail', 'Google Drive']));
  });

  it('returns unknown for a filter entry missing from products', () => {
    const r = parseGoogleWorkspace(incidents, products, { now, components: ['Gmail', 'Gmial'] });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('Gmial');
  });

  it('skips product validation when products is null', () => {
    const r = parseGoogleWorkspace(incidents, null, { now, components: ['Gmail', 'Gmial'] });
    expect(r.status).toBe('operational');
  });

  it('throws ParseError on a bad shape', () => {
    expect(() => parseGoogleWorkspace({ nope: 1 }, null, { now })).toThrow(ParseError);
  });
});
