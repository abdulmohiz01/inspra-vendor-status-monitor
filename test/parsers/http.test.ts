import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHttp } from '../../src/parsers/http.js';

const body = (f: string): string => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8');
const inspra = body('http-inspra-health.json');
const odoo = body('http-odoo-health.json');
const base = { url: 'https://platform.inspra.ai/api/health', slowMs: 5000 };

describe('parseHttp', () => {
  it('is operational for 200 with the expected body', () => {
    const r = parseHttp({ statusCode: 200, body: inspra, latencyMs: 120 }, { ...base, expectBody: '"status":"healthy"' });
    expect(r.status).toBe('operational');
    expect(r.incidents).toEqual([]);
  });

  it('is degraded when the body lacks the expected text', () => {
    const r = parseHttp({ statusCode: 200, body: inspra, latencyMs: 120 }, { ...base, expectBody: '"status":"down"' });
    expect(r.status).toBe('degraded');
    expect(r.incidents[0]!.id).toBe('http-body');
    expect(r.incidents[0]!.title).toContain('"status":"down"');
  });

  it('is major_outage for 5xx', () => {
    const r = parseHttp({ statusCode: 503, body: '', latencyMs: 50 }, base);
    expect(r.status).toBe('major_outage');
    expect(r.incidents[0]!.id).toBe('http-503');
    expect(r.incidents[0]!.title).toContain('HTTP 503');
  });

  it('is unknown for 429', () => {
    expect(parseHttp({ statusCode: 429, body: '', latencyMs: 50 }, base).status).toBe('unknown');
  });

  it('is degraded for other 4xx', () => {
    const r = parseHttp({ statusCode: 404, body: '', latencyMs: 50 }, base);
    expect(r.status).toBe('degraded');
    expect(r.incidents[0]!.id).toBe('http-404');
  });

  it('is degraded when slow', () => {
    const r = parseHttp({ statusCode: 200, body: inspra, latencyMs: 6000 }, base);
    expect(r.status).toBe('degraded');
    expect(r.incidents[0]!.id).toBe('http-slow');
    expect(r.incidents[0]!.title).toContain('6000');
  });

  it('accepts the Odoo health body', () => {
    const r = parseHttp({ statusCode: 200, body: odoo, latencyMs: 80 }, { ...base, expectBody: '"pass"' });
    expect(r.status).toBe('operational');
  });
});
