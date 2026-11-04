import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run-check.js';
import type { Check } from '../src/types.js';

const fetch = (async () => new Response('')) as unknown as typeof globalThis.fetch;
const mk = (id: string, run: Check['run']): Check => ({ id, name: id, kind: 'test', run });

describe('runCheck', () => {
  it('times out a check that ignores the signal', async () => {
    const t0 = Date.now();
    const r = await runCheck(mk('hang', () => new Promise(() => {})), { timeoutMs: 50, fetch });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.status).toBe('unknown');
    expect(r.error).toBe('timed out after 50 ms');
    expect(r.summary).toBe('Check failed: timed out after 50 ms');
    expect(r.components).toEqual([]);
    expect(r.incidents).toEqual([]);
  });

  it('turns a throw into unknown', async () => {
    const r = await runCheck(
      mk('boom', async () => {
        throw new Error('boom');
      }),
      { timeoutMs: 100, fetch },
    );
    expect(r).toMatchObject({ status: 'unknown', error: 'boom', checkId: 'boom' });
  });

  it('decorates a healthy outcome', async () => {
    const now = () => new Date('2026-11-04T01:02:03.000Z');
    const r = await runCheck(
      mk('ok', async () => ({ status: 'operational', components: [], incidents: [] })),
      { timeoutMs: 100, fetch, now },
    );
    expect(r.status).toBe('operational');
    expect(r.checkId).toBe('ok');
    expect(r.checkedAt).toBe('2026-11-04T01:02:03.000Z');
    expect(typeof r.durationMs).toBe('number');
  });

  it('isolates a hanging check from a healthy one', async () => {
    const [a, b] = await Promise.all([
      runCheck(mk('hang', () => new Promise(() => {})), { timeoutMs: 50, fetch }),
      runCheck(mk('ok', async () => ({ status: 'operational', components: [], incidents: [] })), { timeoutMs: 50, fetch }),
    ]);
    expect(a.status).toBe('unknown');
    expect(b.status).toBe('operational');
  });
});
