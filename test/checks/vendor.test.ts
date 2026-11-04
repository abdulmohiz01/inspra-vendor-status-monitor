import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createVendorCheck } from '../../src/checks/vendor.js';
import { parseStatuspage } from '../../src/parsers/statuspage.js';
import type { CheckContext } from '../../src/types.js';
import type { VendorConfig } from '../../src/vendors.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');
const now = new Date('2026-11-04T00:00:00.000Z');

function setup(routes: Record<string, () => Response>) {
  const f = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const r = routes[String(input)];
    return r ? r() : new Response('not found', { status: 404 });
  });
  const ctx: CheckContext = { fetch: f as unknown as typeof fetch, signal: new AbortController().signal, now, timeoutMs: 1000 };
  return { f, ctx };
}
const base = { lookbackHours: 24, slowMs: 5000 };
const requested = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.map((c) => String(c[0]));

describe('createVendorCheck', () => {
  const twilio: VendorConfig = {
    ...base,
    id: 'twilio',
    name: 'Twilio',
    type: 'statuspage',
    url: 'https://status.twilio.com/',
    components: ['PROGRAMMABLE VOICE AU1', 'TWILIO PLATFORM'],
  };

  it('statuspage matches parseStatuspage and requests both endpoints', async () => {
    const { f, ctx } = setup({
      'https://status.twilio.com/api/v2/summary.json': () => new Response(fx('statuspage-twilio-summary.json')),
      'https://status.twilio.com/api/v2/incidents/unresolved.json': () => new Response(fx('statuspage-twilio-unresolved.json')),
    });
    const check = createVendorCheck(twilio);
    expect(check.kind).toBe('statuspage');
    expect(check.pageUrl).toBe('https://status.twilio.com');
    expect(check.sourceUrl).toBe('https://status.twilio.com/api/v2/summary.json');
    const out = await check.run(ctx);
    const expected = parseStatuspage(
      JSON.parse(fx('statuspage-twilio-summary.json')),
      JSON.parse(fx('statuspage-twilio-unresolved.json')),
      { pageUrl: 'https://status.twilio.com', components: twilio.components },
    );
    expect(out).toEqual(expected);
    expect(requested(f).sort()).toEqual([
      'https://status.twilio.com/api/v2/incidents/unresolved.json',
      'https://status.twilio.com/api/v2/summary.json',
    ]);
  });

  it('tolerates a 404 on unresolved.json', async () => {
    const { ctx } = setup({
      'https://status.openai.com/api/v2/summary.json': () => new Response(fx('statuspage-openai-summary.json')),
    });
    const out = await createVendorCheck({ ...base, id: 'openai', name: 'OpenAI', type: 'statuspage', url: 'https://status.openai.com' }).run(ctx);
    expect(out.status).toBe('operational');
  });

  it('betterstack sends Accept: application/json', async () => {
    const { f, ctx } = setup({
      'https://status.vapi.ai/index.json': () => new Response(fx('betterstack-vapi.json')),
    });
    await createVendorCheck({ ...base, id: 'vapi', name: 'Vapi', type: 'betterstack', url: 'https://status.vapi.ai' }).run(ctx);
    const init = f.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
  });

  it('google_workspace requests sibling products.json', async () => {
    const { f, ctx } = setup({
      'https://www.google.com/appsstatus/dashboard/incidents.json': () => new Response(fx('google-workspace-incidents.json')),
      'https://www.google.com/appsstatus/dashboard/products.json': () => new Response(fx('google-workspace-products.json')),
    });
    const check = createVendorCheck({
      ...base,
      id: 'google-workspace',
      name: 'Google Workspace',
      type: 'google_workspace',
      url: 'https://www.google.com/appsstatus/dashboard/incidents.json',
      components: ['Gmail', 'Google Calendar'],
    });
    expect(check.pageUrl).toBe('https://www.google.com/appsstatus/dashboard/');
    await check.run(ctx);
    expect(requested(f)).toContain('https://www.google.com/appsstatus/dashboard/products.json');
  });

  it('http check maps a 503 to major_outage', async () => {
    const { ctx } = setup({ 'https://p.test/health': () => new Response('x', { status: 503 }) });
    const out = await createVendorCheck({ ...base, id: 'p', name: 'P', type: 'http', url: 'https://p.test/health' }).run(ctx);
    expect(out.status).toBe('major_outage');
  });
});
