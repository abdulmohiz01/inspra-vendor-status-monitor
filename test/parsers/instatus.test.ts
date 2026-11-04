import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromInstatus } from '../../src/normalise.js';
import { parseInstatus } from '../../src/parsers/instatus.js';
import { ParseError } from '../../src/types.js';

const load = (f: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
const summary = load('instatus-northflank-summary.json');
const components = load('instatus-northflank-components.json');
const opts = { pageUrl: 'https://status.northflank.com' };

describe('parseInstatus', () => {
  it('reports the live major outage', () => {
    const r = parseInstatus(summary, components, opts);
    expect(r.status).toBe('major_outage');
    expect(r.incidents).toEqual([
      expect.objectContaining({
        id: 'cmvv0rn5a092f14rutwccodpp',
        title: 'Security incident',
        status: 'major_outage',
        url: 'https://status.northflank.com/cmvv0rn5a092f14rutwccodpp',
      }),
    ]);
    expect(r.components).toContainEqual({ name: 'Networking', group: 'Northflank Platform', status: 'major_outage' });
  });

  it('filters to an unaffected component', () => {
    const r = parseInstatus(summary, components, { ...opts, components: ['Northflank App'] });
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('falls back to page status without a components payload', () => {
    const r = parseInstatus(summary, null, opts);
    expect(r.status).toBe(fromInstatus('HASISSUES'));
    expect(r.status).toBe('degraded');
    expect(r.components).toEqual([]);
    expect(r.incidents).toHaveLength(1);
  });

  it('unmatched filter is unknown', () => {
    const r = parseInstatus(summary, components, { ...opts, components: ['Nope'] });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('Nope');
  });

  it('throws ParseError on bad shape', () => {
    expect(() => parseInstatus({}, null, opts)).toThrow(ParseError);
  });
});
