import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStatuspage } from '../../src/parsers/statuspage.js';
import { ParseError } from '../../src/types.js';

const load = (f: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
const opts = { pageUrl: 'https://status.example.com' };

describe('parseStatuspage', () => {
  it('OpenAI summary is operational', () => {
    const r = parseStatuspage(load('statuspage-openai-summary.json'), null, opts);
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
    expect(r.components.length).toBeGreaterThan(5);
    expect(r.summary).toBe('All systems operational');
  });

  it('GitHub is operational', () => {
    const r = parseStatuspage(load('statuspage-github-summary.json'), load('statuspage-github-unresolved.json'), opts);
    expect(r.status).toBe('operational');
  });

  it('Twilio without filter is degraded with 6 unresolved incidents plus the in-progress maintenance', () => {
    const r = parseStatuspage(load('statuspage-twilio-summary.json'), load('statuspage-twilio-unresolved.json'), opts);
    expect(r.status).toBe('degraded');
    // fixture also has one in_progress scheduled maintenance (Tele2 SMS), which the rules surface as an incident
    expect(r.incidents).toHaveLength(7);
    expect(r.incidents.filter((i) => i.status !== 'maintenance')).toHaveLength(6);
    for (const i of r.incidents) expect(i.url).toMatch(/^https:\/\/stspg\.io\//);
  });

  it('Twilio voice filter keeps the degraded component and drops carrier incidents', () => {
    const r = parseStatuspage(load('statuspage-twilio-summary.json'), load('statuspage-twilio-unresolved.json'), {
      ...opts,
      components: [
        'PROGRAMMABLE VOICE AU1',
        'PROGRAMMABLE VOICE US1',
        'ELASTIC SIP TRUNKING AU1',
        'ELASTIC SIP TRUNKING US1',
        'TWILIO PLATFORM',
      ],
    });
    expect(r.status).toBe('degraded');
    expect(r.incidents).toEqual([]);
    expect(r.components).toContainEqual({
      name: 'Media Streams US1',
      group: 'PROGRAMMABLE VOICE US1',
      status: 'degraded',
    });
  });

  it('Twilio narrower filter is operational', () => {
    const r = parseStatuspage(load('statuspage-twilio-summary.json'), load('statuspage-twilio-unresolved.json'), {
      ...opts,
      components: ['PROGRAMMABLE VOICE AU1'],
    });
    expect(r.status).toBe('operational');
  });

  it('unmatched filter entry yields unknown with error', () => {
    const r = parseStatuspage(load('statuspage-twilio-summary.json'), load('statuspage-twilio-unresolved.json'), {
      ...opts,
      components: ['PROGRAMMABLE VOICE AU9'],
    });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('PROGRAMMABLE VOICE AU9');
  });

  it('Telnyx in-progress maintenance becomes a maintenance incident', () => {
    const r = parseStatuspage(load('statuspage-telnyx-summary.json'), null, opts);
    expect(r.status).toBe('maintenance');
    expect(r.incidents).toContainEqual(
      expect.objectContaining({ title: 'Voice Services Update - All Regions', status: 'maintenance' }),
    );
  });

  it('Anthropic is operational', () => {
    const r = parseStatuspage(
      load('statuspage-anthropic-summary.json'),
      load('statuspage-anthropic-unresolved.json'),
      opts,
    );
    expect(r.status).toBe('operational');
  });

  it('throws ParseError on non-JSON shape', () => {
    expect(() => parseStatuspage('<html>', null, opts)).toThrow(ParseError);
  });
});
