import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Check } from '../src/types.js';

const BP = '/insprastatus';
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

const checks: Check[] = [
  {
    id: 'northflank',
    name: 'Northflank',
    kind: 'statuspage',
    pageUrl: 'https://northflank.com',
    feed: 'none',
    run: async () => ({ status: 'operational', components: [], incidents: [] }),
  },
];
const liveness = {
  lastCycleStartedAt: null,
  lastCycleCompletedAt: null,
  cycles: 0,
  running: false,
  intervalSeconds: 180,
};

async function app(basePath = BP) {
  const store = await Store.open({ url: ':memory:' });
  stores.push(store);
  return createApp({ checks, store, poller: { liveness: async () => liveness, isHealthy: () => true }, basePath });
}

describe('createApp under /insprastatus', () => {
  it.each([`${BP}/`, BP])('serves HTML at %s', async (p) => {
    const res = await (await app()).request(p);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves api, healthz and assets under the prefix', async () => {
    const a = await app();
    const api = await a.request(`${BP}/api/status`);
    expect(api.status).toBe(200);
    expect(api.headers.get('content-type')).toContain('application/json');
    expect((await a.request(`${BP}/healthz`)).status).toBe(200);
    const css = await a.request(`${BP}/assets/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toBe('public, max-age=3600');
    const svg = await a.request(`${BP}/assets/favicon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect((await a.request(`${BP}/assets/nope.css`)).status).toBe(404);
  });

  it('redirects / and 404s everything else outside the prefix', async () => {
    const a = await app();
    const root = await a.request('/');
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe(`${BP}/`);
    for (const p of ['/api/status', '/healthz', '/assets/app.css', `${BP}x/healthz`, `${BP}x`]) {
      expect((await a.request(p)).status, p).toBe(404);
    }
  });

  it('uses only prefixed, anchor or absolute-URL links', async () => {
    const html = await (await (await app()).request(`${BP}/`)).text();
    const values = [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(3);
    for (const v of values) {
      expect(v.startsWith('#') || /^https?:\/\//.test(v) || v.startsWith(`${BP}/`), v).toBe(true);
    }
  });

  it('works at the root when basePath is empty', async () => {
    const a = await app('');
    expect((await a.request('/assets/app.css')).status).toBe(200);
    const res = await a.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toMatch(/href="\/assets\/app\.css\?v=[0-9a-f]{10}"/);
  });
});
