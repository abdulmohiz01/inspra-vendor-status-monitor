import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBetterstack } from '../../src/parsers/betterstack.js';
import { ParseError } from '../../src/types.js';

const load = (f: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
const vapi = load('betterstack-vapi.json');
const ghl = load('betterstack-gohighlevel.json');
const vapiOpts = { pageUrl: 'https://status.vapi.ai' };
const ghlOpts = { pageUrl: 'https://status.gohighlevel.com' };
const before = new Date('2026-11-04T13:00:00Z');

describe('parseBetterstack', () => {
  it('Vapi is operational while the maintenance is in the future', () => {
    const r = parseBetterstack(vapi, { ...vapiOpts, now: before });
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('drops not_monitored resources', () => {
    const r = parseBetterstack(vapi, { ...vapiOpts, now: before });
    // fixture has 30 resources, 3 of them not_monitored
    expect(r.components).toHaveLength(27);
  });

  it('Vapi shows the maintenance inside its window', () => {
    const r = parseBetterstack(vapi, { ...vapiOpts, now: new Date('2026-11-08T05:05:00Z') });
    expect(r.status).toBe('maintenance');
    expect(r.incidents).toEqual([
      expect.objectContaining({
        id: '1108915',
        status: 'maintenance',
        url: 'https://status.vapi.ai/maintenance/1108915',
      }),
    ]);
  });

  it('GoHighLevel is operational', () => {
    expect(parseBetterstack(ghl, { ...ghlOpts, now: before }).status).toBe('operational');
  });

  it('filters by resource name', () => {
    const r = parseBetterstack(ghl, { ...ghlOpts, now: before, components: ['app.gohighlevel.com'] });
    expect(r.status).toBe('operational');
    expect(r.components).toHaveLength(1);
  });

  it('unmatched filter is unknown', () => {
    const r = parseBetterstack(ghl, { ...ghlOpts, now: before, components: ['nope.example'] });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('nope.example');
  });

  it('throws ParseError on bad shape', () => {
    expect(() => parseBetterstack('<html>', { ...ghlOpts, now: before })).toThrow(ParseError);
  });
});
