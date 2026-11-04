import { describe, expect, it, vi } from 'vitest';
import { FetchError, USER_AGENT, fetchJson, fetchText } from '../src/fetcher.js';
import { ParseError, type CheckContext } from '../src/types.js';

function ctx(fetchImpl: typeof fetch): CheckContext {
  return { fetch: fetchImpl, signal: new AbortController().signal, now: new Date(), timeoutMs: 1000 };
}
const fake = (res: () => Response) => vi.fn(async () => res()) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('fetchJson', () => {
  it('parses a 200 JSON body', async () => {
    const f = fake(() => new Response('{"a":1}', { status: 200 }));
    expect(await fetchJson(ctx(f), 'https://x.test/a')).toEqual({ a: 1 });
  });

  it('returns null for 404 when optional', async () => {
    const f = fake(() => new Response('nope', { status: 404 }));
    expect(await fetchJson(ctx(f), 'https://x.test/a', { optional: true })).toBeNull();
  });

  it('throws FetchError for 404 when not optional', async () => {
    const f = fake(() => new Response('nope', { status: 404 }));
    const p = fetchJson(ctx(f), 'https://x.test/a');
    await expect(p).rejects.toBeInstanceOf(FetchError);
    await expect(p).rejects.toThrow('HTTP 404 from https://x.test/a');
  });

  it('throws ParseError for an HTML body', async () => {
    const f = fake(() => new Response('<html>', { status: 200 }));
    const p = fetchJson(ctx(f), 'https://x.test/a');
    await expect(p).rejects.toBeInstanceOf(ParseError);
    await expect(p).rejects.toThrow('invalid JSON from https://x.test/a');
  });

  it('sends the user-agent, extra headers and the signal', async () => {
    const f = fake(() => new Response('{}', { status: 200 }));
    const c = ctx(f);
    await fetchJson(c, 'https://x.test/a', { headers: { Accept: 'application/json' } });
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    const h = new Headers(init.headers);
    expect(h.get('user-agent')).toBe(USER_AGENT);
    expect(USER_AGENT).toBe('inspra-vendor-status-monitor/1.0');
    expect(h.get('accept')).toBe('application/json');
    expect(init.signal).toBe(c.signal);
  });

  it('wraps network rejection in FetchError', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(fetchJson(ctx(f), 'https://x.test/a')).rejects.toBeInstanceOf(FetchError);
  });
});

describe('fetchText', () => {
  it('returns status, body and latency without throwing on 503', async () => {
    const f = fake(() => new Response('down', { status: 503 }));
    const r = await fetchText(ctx(f), 'https://x.test/a');
    expect(r.statusCode).toBe(503);
    expect(r.body).toBe('down');
    expect(typeof r.latencyMs).toBe('number');
  });

  it('rejects bodies over 5 MB with FetchError', async () => {
    const f = fake(() => new Response('a'.repeat(5 * 1024 * 1024 + 1), { status: 200 }));
    await expect(fetchText(ctx(f), 'https://x.test/a')).rejects.toBeInstanceOf(FetchError);
  });
});
