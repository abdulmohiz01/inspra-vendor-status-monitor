import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AlertEvent } from '../src/alerts/decide.js';
import { Store } from '../src/store.js';
import type { CheckResult, Incident, Status } from '../src/types.js';

const stores: Store[] = [];
const dirs: string[] = [];
async function open(url: string): Promise<Store> {
  const s = await Store.open({ url });
  stores.push(s);
  return s;
}
const mem = (): Promise<Store> => open(':memory:');
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vsm-'));
  dirs.push(dir);
  return dir;
}
const fileUrl = (path: string): string => 'file:' + path.split(String.fromCharCode(92)).join('/');
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // libsql on Windows releases the file handle only when the client is garbage collected.
    }
  }
});

function res(status: Status, at: string, extra: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId: 'a',
    checkedAt: at,
    durationMs: 12,
    status,
    summary: 's',
    components: [],
    incidents: [],
    ...extra,
  };
}
const inc: Incident = { id: 'i1', title: 'Broken', status: 'degraded', url: 'https://x/i1' };
const T0 = '2026-11-04T00:00:00.000Z';
const T1 = '2026-11-04T01:00:00.000Z';
const T2 = '2026-11-04T02:00:00.000Z';

describe('Store', () => {
  it('round-trips latest result', async () => {
    const s = await mem();
    const r = res('degraded', T0, { incidents: [inc] });
    await s.recordResult(r);
    expect((await s.latestResults()).get('a')).toEqual(r);
  });

  it('resolves an incident when it disappears', async () => {
    const s = await mem();
    await s.recordResult(res('degraded', T0, { incidents: [inc] }));
    expect(await s.incidents('a', { openOnly: true })).toHaveLength(1);
    await s.recordResult(res('operational', T1));
    const all = await s.incidents('a');
    expect(all).toHaveLength(1);
    expect(all[0]!.resolvedAt).toBe(T1);
    expect(all[0]!.startedAt).toBe(T0);
    expect(await s.incidents('a', { openOnly: true })).toHaveLength(0);
  });

  it('reopens a resolved incident that reappears', async () => {
    const s = await mem();
    await s.recordResult(res('degraded', T0, { incidents: [inc] }));
    await s.recordResult(res('operational', T1));
    await s.recordResult(res('degraded', T2, { incidents: [inc] }));
    const [i] = await s.incidents('a');
    expect(i!.resolvedAt).toBeNull();
    expect(i!.lastSeenAt).toBe(T2);
  });

  it('keeps incident open on a fetch failure', async () => {
    const s = await mem();
    await s.recordResult(res('degraded', T0, { incidents: [inc] }));
    await s.recordResult(res('unknown', T1, { error: 'timeout' }));
    expect(await s.incidents('a', { openOnly: true })).toHaveLength(1);
  });

  it('round-trips alert state; missing is undefined', async () => {
    const s = await mem();
    expect(await s.getAlertState('a')).toBeUndefined();
    const st = {
      alertedStatus: 'degraded' as const,
      alertedIncidentIds: ['i1'],
      consecutiveUnknown: 0,
      lastAlertAt: T0,
      since: T0,
    };
    await s.saveAlertState('a', st);
    expect(await s.getAlertState('a')).toEqual(st);
  });

  it('logs alerts', async () => {
    const s = await mem();
    await s.logAlert({
      kind: 'degraded',
      checkId: 'a',
      checkName: 'A',
      from: null,
      to: 'degraded',
      since: T0,
      at: T0,
      incidents: [],
      components: [],
      dedupeKey: 'a:state:degraded',
    });
    expect(await s.recentAlerts(10)).toEqual([
      { dedupeKey: 'a:state:degraded', kind: 'degraded', checkId: 'a', at: T0 },
    ]);
  });

  it('dailyHistory uses worst non-unknown status per UTC day', async () => {
    const s = await mem();
    await s.recordResult(res('degraded', '2026-11-03T10:00:00.000Z'));
    await s.recordResult(res('operational', '2026-11-03T11:00:00.000Z'));
    await s.recordResult(res('unknown', '2026-11-04T10:00:00.000Z', { error: 'x' }));
    const h = (await s.dailyHistory(7, new Date('2026-11-04T12:00:00Z'))).get('a');
    expect(h).toEqual([
      { day: '2026-11-03', status: 'degraded' },
      { day: '2026-11-04', status: 'unknown' },
    ]);
  });

  it('prune deletes old history, old alerts and old resolved incidents; keeps open ones', async () => {
    const s = await mem();
    const now = new Date('2026-11-04T12:00:00Z');
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    await s.recordResult(res('operational', ago(31)));
    await s.recordResult(res('operational', ago(29)));
    // resolved long ago
    await s.recordResult(res('degraded', ago(40), { checkId: 'b', incidents: [inc] }));
    await s.recordResult(res('operational', ago(35), { checkId: 'b' }));
    // open and old
    await s.recordResult(res('degraded', ago(40), { checkId: 'c', incidents: [inc] }));
    // resolved recently
    await s.recordResult(res('degraded', ago(40), { checkId: 'd', incidents: [inc] }));
    await s.recordResult(res('operational', ago(5), { checkId: 'd' }));
    const ev = (at: string, key: string): AlertEvent =>
      ({ kind: 'degraded', checkId: 'a', checkName: 'A', from: null, to: 'degraded', since: at, at, incidents: [], components: [], dedupeKey: key });
    await s.logAlert(ev(ago(31), 'old'));
    await s.logAlert(ev(ago(1), 'new'));

    expect(await s.prune(30, now)).toBe(5);
    expect((await s.recentAlerts(10)).map((a) => a.dedupeKey)).toEqual(['new']);
    expect(await s.incidents('b')).toHaveLength(0);
    expect(await s.incidents('c', { openOnly: true })).toHaveLength(1);
    expect(await s.incidents('d')).toHaveLength(1);
    expect((await s.dailyHistory(60, now)).get('a')).toHaveLength(1);
  });

  describe('alert outbox', () => {
    const NOW = new Date('2026-11-04T12:00:00Z');
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    const ev = (at: string, key: string, checkId = 'a', kind: AlertEvent['kind'] = 'degraded'): AlertEvent => ({
      kind,
      checkId,
      checkName: 'A',
      from: 'operational',
      to: 'major_outage',
      since: at,
      at,
      incidents: [inc],
      components: [{ name: 'API', status: 'major_outage' }],
      pageUrl: 'https://status.a.test',
      dedupeKey: key,
    });
    const opts = { maxAttempts: 5, minCreatedAt: new Date(NOW.getTime() - 24 * 3_600_000) };

    it('logAlert returns the row id; a new alert is pending with its full event payload', async () => {
      const s = await mem();
      const e = ev(hoursAgo(1), 'k1');
      const id = await s.logAlert(e);
      expect(typeof id).toBe('number');
      expect(await s.pendingAlerts(opts)).toEqual([{ id, attempts: 0, event: e }]);
    });

    it('markAlertSent removes it from pending', async () => {
      const s = await mem();
      const id = await s.logAlert(ev(hoursAgo(1), 'k1'));
      await s.markAlertSent(id, NOW);
      expect(await s.pendingAlerts(opts)).toEqual([]);
    });

    it('markAlertFailed increments attempts and keeps it pending until the cap', async () => {
      const s = await mem();
      const id = await s.logAlert(ev(hoursAgo(1), 'k1'));
      for (let i = 1; i <= 4; i++) {
        await s.markAlertFailed(id, `boom ${i}`);
        expect((await s.pendingAlerts(opts)).map((p) => p.attempts)).toEqual([i]);
      }
      await s.markAlertFailed(id, 'boom 5');
      expect(await s.pendingAlerts(opts)).toEqual([]);
    });

    it('excludes alerts older than minCreatedAt and returns the rest oldest first', async () => {
      const s = await mem();
      await s.logAlert(ev(hoursAgo(25), 'too-old', 'x'));
      const newer = await s.logAlert(ev(hoursAgo(1), 'newer', 'b'));
      const older = await s.logAlert(ev(hoursAgo(23), 'older', 'c'));
      expect((await s.pendingAlerts(opts)).map((p) => p.id)).toEqual([older, newer]);
    });

    it('drops an unsent alert once a newer alert exists for the same check (no stale degraded after recovered)', async () => {
      const s = await mem();
      await s.logAlert(ev(hoursAgo(3), 'a:state:major_outage'));
      const recovered = await s.logAlert(ev(hoursAgo(2), 'a:state:operational', 'a', 'recovered'));
      await s.markAlertSent(recovered, NOW);
      const other = await s.logAlert(ev(hoursAgo(3), 'b:state:major_outage', 'b'));
      expect((await s.pendingAlerts(opts)).map((p) => p.id)).toEqual([other]);

      // The newest alert for a check stays retryable while it is unsent.
      const worse = await s.logAlert(ev(hoursAgo(1), 'a:state:degraded', 'a'));
      expect((await s.pendingAlerts(opts)).map((p) => p.id)).toEqual([other, worse]);
    });

    it('prune deletes old alerts whether sent or not', async () => {
      const s = await mem();
      const sent = await s.logAlert(ev(hoursAgo(31 * 24), 'old-sent'));
      await s.markAlertSent(sent, NOW);
      await s.logAlert(ev(hoursAgo(31 * 24), 'old-unsent'));
      await s.logAlert(ev(hoursAgo(1), 'new'));
      await s.prune(30, NOW);
      expect((await s.recentAlerts(10)).map((a) => a.dedupeKey)).toEqual(['new']);
    });

    /** A database file with the alerts table as it was before the outbox columns existed. */
    async function oldSchemaDb(): Promise<string> {
      const url = fileUrl(join(tempDir(), 'old.db'));
      const old = createClient({ url });
      await old.execute(`CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        check_id TEXT NOT NULL,
        at TEXT NOT NULL,
        event_json TEXT NOT NULL
      )`);
      const e = ev(hoursAgo(1), 'pre-outbox');
      await old.execute({
        sql: 'INSERT INTO alerts (dedupe_key, kind, check_id, at, event_json) VALUES (?, ?, ?, ?, ?)',
        args: [e.dedupeKey, e.kind, e.checkId, e.at, JSON.stringify(e)],
      });
      old.close();
      return url;
    }

    it('migrates an old-schema alerts table idempotently without re-sending its rows', async () => {
      const url = await oldSchemaDb();
      (await open(url)).close();
      const s = await open(url);
      const inspect = createClient({ url });
      const cols = (await inspect.execute('PRAGMA table_info(alerts)')).rows.map((c) => String(c['name']));
      inspect.close();
      expect(cols).toEqual(expect.arrayContaining(['sent_at', 'attempts', 'last_error']));
      // Rows written before the outbox existed already had their one delivery attempt.
      expect(await s.pendingAlerts(opts)).toEqual([]);
      const id = await s.logAlert(ev(hoursAgo(1), 'post-outbox'));
      expect((await s.pendingAlerts(opts)).map((p) => p.id)).toEqual([id]);
    });

    it('survives two cold starts migrating the same old database at once', async () => {
      const url = await oldSchemaDb();
      const [a, b] = await Promise.all([open(url), open(url)]);
      expect(await a.pendingAlerts(opts)).toEqual([]);
      const id = await b.logAlert(ev(hoursAgo(1), 'post-outbox'));
      expect((await a.pendingAlerts(opts)).map((p) => p.id)).toEqual([id]);
    });

    it('commitCycleResult records the result, saves state and logs alerts in one batch', async () => {
      const s = await mem();
      const st = { alertedStatus: 'major_outage' as const, alertedIncidentIds: ['i1'], consecutiveUnknown: 0, lastAlertAt: T0, since: T0 };
      const ids = await s.commitCycleResult(res('major_outage', T0, { incidents: [inc] }), st, [
        ev(T0, 'a:state:major_outage'),
        ev(T0, 'a:incident:i1'),
      ]);
      expect(ids).toHaveLength(2);
      expect(ids.every((id) => typeof id === 'number')).toBe(true);
      expect((await s.latestResults()).get('a')?.status).toBe('major_outage');
      expect(await s.getAlertState('a')).toEqual(st);
      expect(await s.incidents('a', { openOnly: true })).toHaveLength(1);
      expect((await s.recentAlerts(10)).map((a) => a.dedupeKey).sort()).toEqual(['a:incident:i1', 'a:state:major_outage']);
    });
  });

  describe('poller state', () => {
    const at = (ms: number) => new Date(Date.parse(T0) + ms);

    it('starts with no cycles recorded', async () => {
      const s = await mem();
      expect(await s.pollerRecord(at(0))).toEqual({
        lastCycleStartedAt: null,
        lastCycleCompletedAt: null,
        cycles: 0,
        running: false,
      });
    });

    it('tryStartCycle holds the lock until it expires or the cycle finishes', async () => {
      const s = await mem();
      expect(await s.tryStartCycle(at(0), 60_000)).not.toBeNull();
      expect(await s.tryStartCycle(at(1_000), 60_000)).toBeNull();
      expect((await s.pollerRecord(at(1_000))).running).toBe(true);
      // An invocation killed mid-cycle never finishes; its lock lapses after the TTL.
      const owner = await s.tryStartCycle(at(60_000), 60_000);
      expect(owner).not.toBeNull();
      await s.finishCycle(at(61_000), owner!);
      expect(await s.pollerRecord(at(61_000))).toEqual({
        lastCycleStartedAt: at(60_000).toISOString(),
        lastCycleCompletedAt: at(61_000).toISOString(),
        cycles: 1,
        running: false,
      });
      expect(await s.tryStartCycle(at(62_000), 60_000)).not.toBeNull();
    });

    it('a cycle that outlived its lock does not release the lock its successor took', async () => {
      const s = await mem();
      const first = await s.tryStartCycle(at(0), 60_000);
      const second = await s.tryStartCycle(at(60_000), 60_000);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      await s.finishCycle(at(61_000), first!);
      // The late finisher still counts as a completed cycle, but the successor keeps the lock.
      expect(await s.pollerRecord(at(61_000))).toMatchObject({ cycles: 1, running: true });
      expect(await s.tryStartCycle(at(62_000), 60_000)).toBeNull();
      await s.finishCycle(at(63_000), second!);
      expect(await s.pollerRecord(at(63_000))).toMatchObject({ cycles: 2, running: false });
    });

    it('claimPrune grants one prune per interval', async () => {
      const s = await mem();
      await s.tryStartCycle(at(0), 60_000);
      expect(await s.claimPrune(at(0), 3_600_000)).toBe(true);
      expect(await s.claimPrune(at(1_000), 3_600_000)).toBe(false);
      expect(await s.claimPrune(at(3_600_000), 3_600_000)).toBe(true);
    });

    it('two stores on one file database share the lock', async () => {
      const url = fileUrl(join(tempDir(), 'shared.db'));
      const a = await open(url);
      const b = await open(url);
      const owner = await a.tryStartCycle(at(0), 60_000);
      expect(owner).not.toBeNull();
      expect(await b.tryStartCycle(at(10), 60_000)).toBeNull();
      await a.finishCycle(at(20), owner!);
      expect((await b.pollerRecord(at(30))).cycles).toBe(1);
    });
  });

  it('creates the parent directory of a file: database and persists across reopen', async () => {
    const p = join(tempDir(), 'nested', 'dir', 'x.db');
    const first = await open(fileUrl(p));
    expect(existsSync(p)).toBe(true);
    await first.recordResult(res('degraded', T0));
    first.close();
    const again = await open(fileUrl(p));
    expect((await again.latestResults()).get('a')?.status).toBe('degraded');
  });
});
