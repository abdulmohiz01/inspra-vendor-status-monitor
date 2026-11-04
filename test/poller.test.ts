import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../src/alerts/decide.js';
import { createNotifier, type DeliveryResult, type Notifier } from '../src/alerts/notifier.js';
import { nextDelayMs, Poller } from '../src/poller.js';
import { Store } from '../src/store.js';
import type { Check, CheckOutcome, Status } from '../src/types.js';

const stores: Store[] = [];
const dirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const config = {
  pollIntervalSeconds: 180,
  fetchTimeoutMs: 50,
  alertReminderMinutes: 60,
  unknownAlertThreshold: 3,
  historyRetentionDays: 30,
};
const fakeFetch = vi.fn() as never;

function mem(): Store {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
}

function notifier(): Notifier & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    events,
    notify: async (e) => {
      events.push(e);
      return { ok: true };
    },
  };
}

function check(id: string, get: () => Status | 'hang'): Check {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'fake',
    run: async (): Promise<CheckOutcome> => {
      const s = get();
      if (s === 'hang') return new Promise<CheckOutcome>(() => undefined);
      return {
        status: s,
        components: s === 'operational' ? [] : [{ name: 'API', status: s }],
        incidents: [],
      };
    },
  };
}

function clock(start = '2026-11-04T10:00:00Z') {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

function poller(checks: Check[], store: Store, n: Notifier, extra: object = {}) {
  return new Poller({ checks, store, notifier: n, config, log, fetch: fakeFetch, ...extra });
}

describe('nextDelayMs', () => {
  it('adds bounded jitter', () => {
    expect(nextDelayMs(180, () => 0)).toBe(180000);
    expect(nextDelayMs(180, () => 0.999)).toBeLessThan(180000 + 15000);
    expect(nextDelayMs(600, () => 0.999)).toBeLessThan(615000);
  });
});

describe('Poller', () => {
  it('completes a cycle with a hanging check recorded as unknown', async () => {
    const store = mem();
    const p = poller([check('ok', () => 'operational'), check('slow', () => 'hang')], store, notifier());
    const results = await p.runCycle();
    expect(results).toHaveLength(2);
    expect(store.latestResults().get('slow')?.status).toBe('unknown');
    expect(store.latestResults().get('ok')?.status).toBe('operational');
    expect(p.liveness().cycles).toBe(1);
    expect(p.liveness().running).toBe(false);
  });

  it('notifies exactly one degraded event across cycles', async () => {
    let s: Status = 'operational';
    const n = notifier();
    const p = poller([check('a', () => s)], mem(), n);
    await p.runCycle();
    s = 'major_outage';
    await p.runCycle();
    await p.runCycle();
    expect(n.events.filter((e) => e.kind === 'degraded')).toHaveLength(1);
    expect(n.events).toHaveLength(1);
  });

  it('does not re-notify after a restart on the same database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'));
    dirs.push(dir);
    const file = join(dir, 'db.sqlite');
    const n1 = notifier();
    const s1 = new Store(file);
    stores.push(s1);
    await poller([check('a', () => 'major_outage')], s1, n1).runCycle();
    expect(n1.events).toHaveLength(1);
    s1.close();

    const n2 = notifier();
    const s2 = new Store(file);
    stores.push(s2);
    await poller([check('a', () => 'major_outage')], s2, n2).runCycle();
    expect(n2.events).toHaveLength(0);
  });

  it('reports health from the last completed cycle', async () => {
    const c = clock();
    const p = poller([check('a', () => 'operational')], mem(), notifier(), { now: c.now });
    expect(p.isHealthy(c.now())).toBe(true);
    await p.runCycle();
    expect(p.isHealthy(c.now())).toBe(true);
    const windowS = 2 * config.pollIntervalSeconds + config.fetchTimeoutMs / 1000 + 30;
    c.advance((windowS + 1) * 1000);
    expect(p.isHealthy(c.now())).toBe(false);
  });

  it('is unhealthy when no cycle ever completes within the window', () => {
    const c = clock();
    const p = poller([], mem(), notifier(), { now: c.now });
    c.advance(10 * 60 * 1000);
    expect(p.isHealthy(c.now())).toBe(false);
  });

  it('skips an overlapping cycle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Check = {
      id: 'g',
      name: 'G',
      kind: 'fake',
      run: async () => {
        await gate;
        return { status: 'operational', components: [], incidents: [] };
      },
    };
    const p = new Poller({
      checks: [slow],
      store: mem(),
      notifier: notifier(),
      config: { ...config, fetchTimeoutMs: 5000 },
      log,
      fetch: fakeFetch,
    });
    const first = p.runCycle();
    expect(p.liveness().running).toBe(true);
    expect(await p.runCycle()).toEqual([]);
    release();
    expect(await first).toHaveLength(1);
    expect(p.liveness().cycles).toBe(1);
  });

  it('isolates a failing record and continues with other results', async () => {
    const store = mem();
    const orig = store.recordResult.bind(store);
    vi.spyOn(store, 'recordResult').mockImplementation((r) => {
      if (r.checkId === 'a') throw new Error('disk');
      orig(r);
    });
    const p = poller([check('a', () => 'operational'), check('b', () => 'operational')], store, notifier());
    await p.runCycle();
    expect(store.latestResults().has('b')).toBe(true);
    expect(log.error).toHaveBeenCalled();
  });

  it('prunes at most once per hour', async () => {
    const c = clock();
    const store = mem();
    const prune = vi.spyOn(store, 'prune');
    const p = poller([check('a', () => 'operational')], store, notifier(), { now: c.now });
    await p.runCycle();
    await p.runCycle();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(30, expect.any(Date));
    c.advance(3_600_001);
    await p.runCycle();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('start() runs a cycle then arms one timer; the timer runs another; stop() clears it', async () => {
    vi.useFakeTimers();
    const p = poller([check('a', () => 'operational')], mem(), notifier(), { random: () => 0 });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.liveness().cycles).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(p.liveness().cycles).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    await p.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(p.liveness().cycles).toBe(2);
  });

  it('stop() waits for the in-flight cycle', async () => {
    const p = poller([check('a', () => 'operational')], mem(), notifier(), { random: () => 0 });
    p.start();
    await p.stop();
    expect(p.liveness().cycles).toBe(1);
    expect(p.liveness().running).toBe(false);
  });

  it.each([
    ['rejects', (m: string) => Promise.reject(new Error(m))],
    ['throws synchronously', (m: string): Promise<DeliveryResult> => {
      throw new Error(m);
    }],
  ] as const)('keeps notifying other checks when notify %s', async (_name, fail) => {
    const seen: string[] = [];
    const n: Notifier = {
      notify: (e) => {
        if (e.checkId === 'a') return fail('notify boom');
        seen.push(e.checkId);
        return Promise.resolve({ ok: true });
      },
    };
    const p = poller([check('a', () => 'major_outage'), check('b', () => 'major_outage')], mem(), n);
    const results = await p.runCycle();
    expect(results).toHaveLength(2);
    expect(seen).toEqual(['b']);
    expect(log.error).toHaveBeenCalledWith('notify failed', expect.objectContaining({ checkId: 'a' }));
    expect(p.liveness().cycles).toBe(1);
  });

  it('still notifies when logAlert throws', async () => {
    const store = mem();
    vi.spyOn(store, 'logAlert').mockImplementation(() => {
      throw new Error('log boom');
    });
    const n = notifier();
    await poller([check('a', () => 'major_outage')], store, n).runCycle();
    expect(n.events).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith('failed to log alert', expect.objectContaining({ checkId: 'a' }));
  });

  it('saves alert state before notifying and logs each event once', async () => {
    const store = mem();
    const order: string[] = [];
    vi.spyOn(store, 'saveAlertState').mockImplementation(() => void order.push('save'));
    const logAlert = vi.spyOn(store, 'logAlert').mockImplementation(() => order.push('log'));
    const n: Notifier = {
      notify: async () => {
        order.push('notify');
        return { ok: true };
      },
    };
    await poller([check('a', () => 'major_outage')], store, n).runCycle();
    expect(order[0]).toBe('save');
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('notify'));
    expect(logAlert).toHaveBeenCalledTimes(1);
  });

  describe('alert outbox', () => {
    const DAY = 24 * 3_600_000;
    const pending = (store: Store, c: { now: () => Date }) =>
      store.pendingAlerts({ maxAttempts: 5, minCreatedAt: new Date(c.now().getTime() - DAY) });

    function flaky(results: DeliveryResult[]): Notifier & { calls: AlertEvent[] } {
      const calls: AlertEvent[] = [];
      return {
        calls,
        notify: async (e) => {
          calls.push(e);
          return results.shift() ?? { ok: true };
        },
      };
    }

    it('marks a delivered alert sent', async () => {
      const c = clock();
      const store = mem();
      await poller([check('a', () => 'major_outage')], store, notifier(), { now: c.now }).runCycle();
      expect(pending(store, c)).toEqual([]);
    });

    it('retries a failed alert at the start of the next cycle and marks it sent', async () => {
      const c = clock();
      const store = mem();
      const n = flaky([{ ok: false, error: 'slack: HTTP 503' }]);
      const p = poller([check('a', () => 'major_outage')], store, n, { now: c.now });
      await p.runCycle();
      expect(n.calls.map((e) => e.dedupeKey)).toEqual(['a:state:major_outage']);
      expect(pending(store, c)).toMatchObject([{ attempts: 1, event: { dedupeKey: 'a:state:major_outage' } }]);

      c.advance(180_000);
      await p.runCycle();
      expect(n.calls.map((e) => e.dedupeKey)).toEqual(['a:state:major_outage', 'a:state:major_outage']);
      expect(n.calls[1]).toEqual(n.calls[0]);
      expect(pending(store, c)).toEqual([]);
      expect(log.info).toHaveBeenCalledWith(
        'retrying alert',
        expect.objectContaining({ checkId: 'a', dedupeKey: 'a:state:major_outage', attempts: 1 }),
      );

      c.advance(180_000);
      await p.runCycle();
      expect(n.calls).toHaveLength(2);
    });

    it('retries pending alerts before the checks run', async () => {
      const c = clock();
      const store = mem();
      const order: string[] = [];
      let first = true;
      const n: Notifier = {
        notify: async (e) => {
          order.push(`notify:${e.checkId}`);
          if (first) {
            first = false;
            return { ok: false, error: 'x' };
          }
          return { ok: true };
        },
      };
      let bStatus: Status = 'operational';
      const b: Check = {
        id: 'b',
        name: 'B',
        kind: 'fake',
        run: async () => {
          order.push('run:b');
          return { status: bStatus, components: [], incidents: [] };
        },
      };
      const p = poller([check('a', () => 'major_outage'), b], store, n, { now: c.now });
      await p.runCycle();
      order.length = 0;
      bStatus = 'major_outage';
      c.advance(180_000);
      await p.runCycle();
      expect(order).toEqual(['notify:a', 'run:b', 'notify:b']);
    });

    it('marks a thrown notify as failed and retries it', async () => {
      const c = clock();
      const store = mem();
      let calls = 0;
      const n: Notifier = {
        notify: async () => {
          calls += 1;
          if (calls === 1) throw new Error('boom');
          return { ok: true };
        },
      };
      const p = poller([check('a', () => 'major_outage')], store, n, { now: c.now });
      await p.runCycle();
      expect(pending(store, c)).toHaveLength(1);
      c.advance(180_000);
      await p.runCycle();
      expect(calls).toBe(2);
      expect(pending(store, c)).toEqual([]);
    });

    it('gives up after 5 attempts', async () => {
      const c = clock();
      const store = mem();
      const n = flaky(Array.from({ length: 20 }, () => ({ ok: false, error: 'down' })));
      const p = poller([check('a', () => 'major_outage')], store, n, { now: c.now });
      for (let i = 0; i < 8; i++) {
        await p.runCycle();
        c.advance(180_000);
      }
      expect(n.calls.filter((e) => e.dedupeKey === 'a:state:major_outage')).toHaveLength(5);
      expect(pending(store, c)).toEqual([]);
    });

    it('does not retry alerts older than 24h', async () => {
      const c = clock();
      const store = mem();
      const n = flaky([{ ok: false, error: 'down' }]);
      const p = poller([check('a', () => 'major_outage')], store, n, { now: c.now });
      await p.runCycle();
      c.advance(DAY + 1);
      await p.runCycle();
      expect(n.calls.filter((e) => e.dedupeKey === 'a:state:major_outage')).toHaveLength(1);
    });

    it('marks alerts sent in log-only mode (no channels configured)', async () => {
      const c = clock();
      const store = mem();
      const n = createNotifier({ appUrl: 'https://x.test/insprastatus' }, { fetch: fakeFetch, log });
      await poller([check('a', () => 'major_outage')], store, n, { now: c.now }).runCycle();
      expect(pending(store, c)).toEqual([]);
      expect(log.info).toHaveBeenCalledWith('slack webhook not configured; alert payload', expect.anything());
    });
  });

  describe('concurrent sends', () => {
    function slowNotifier(ms: number, ok = true) {
      const st = { inFlight: 0, max: 0, calls: 0 };
      const n: Notifier = {
        notify: async () => {
          st.calls += 1;
          st.inFlight += 1;
          st.max = Math.max(st.max, st.inFlight);
          await new Promise((r) => setTimeout(r, ms));
          st.inFlight -= 1;
          return ok ? { ok: true } : { ok: false, error: 'down' };
        },
      };
      return { n, st };
    }
    const eight = () => Array.from({ length: 8 }, (_, i) => check(`c${i}`, () => 'major_outage'));

    it('sends a cycle of 8 events at most 4 at a time, well under 8 x the send time', async () => {
      const { n, st } = slowNotifier(100);
      const p = poller(eight(), mem(), n);
      const t0 = performance.now();
      await p.runCycle();
      const elapsed = performance.now() - t0;
      expect(st.calls).toBe(8);
      expect(st.max).toBe(4);
      expect(elapsed).toBeLessThan(500);
    });

    it('bounds the retry batch to 4 in flight too', async () => {
      const c = clock();
      const store = mem();
      const failing = slowNotifier(10, false);
      await poller(eight(), store, failing.n, { now: c.now }).runCycle();
      const retry = slowNotifier(20);
      c.advance(180_000);
      await poller(eight(), store, retry.n, { now: c.now }).runCycle();
      expect(retry.st.calls).toBe(8);
      expect(retry.st.max).toBe(4);
    });
  });
});
