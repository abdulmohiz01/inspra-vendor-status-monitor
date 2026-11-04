import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AlertEvent } from '../src/alerts/decide.js';
import { Store } from '../src/store.js';
import type { CheckResult, Incident, Status } from '../src/types.js';

const stores: Store[] = [];
const dirs: string[] = [];
function mem(): Store {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
  it('round-trips latest result', () => {
    const s = mem();
    const r = res('degraded', T0, { incidents: [inc] });
    s.recordResult(r);
    expect(s.latestResults().get('a')).toEqual(r);
  });

  it('resolves an incident when it disappears', () => {
    const s = mem();
    s.recordResult(res('degraded', T0, { incidents: [inc] }));
    expect(s.incidents('a', { openOnly: true })).toHaveLength(1);
    s.recordResult(res('operational', T1));
    const all = s.incidents('a');
    expect(all).toHaveLength(1);
    expect(all[0]!.resolvedAt).toBe(T1);
    expect(all[0]!.startedAt).toBe(T0);
    expect(s.incidents('a', { openOnly: true })).toHaveLength(0);
  });

  it('reopens a resolved incident that reappears', () => {
    const s = mem();
    s.recordResult(res('degraded', T0, { incidents: [inc] }));
    s.recordResult(res('operational', T1));
    s.recordResult(res('degraded', T2, { incidents: [inc] }));
    const [i] = s.incidents('a');
    expect(i!.resolvedAt).toBeNull();
    expect(i!.lastSeenAt).toBe(T2);
  });

  it('keeps incident open on a fetch failure', () => {
    const s = mem();
    s.recordResult(res('degraded', T0, { incidents: [inc] }));
    s.recordResult(res('unknown', T1, { error: 'timeout' }));
    expect(s.incidents('a', { openOnly: true })).toHaveLength(1);
  });

  it('round-trips alert state; missing is undefined', () => {
    const s = mem();
    expect(s.getAlertState('a')).toBeUndefined();
    const st = {
      alertedStatus: 'degraded' as const,
      alertedIncidentIds: ['i1'],
      consecutiveUnknown: 0,
      lastAlertAt: T0,
      since: T0,
    };
    s.saveAlertState('a', st);
    expect(s.getAlertState('a')).toEqual(st);
  });

  it('logs alerts', () => {
    const s = mem();
    s.logAlert({
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
    expect(s.recentAlerts(10)).toEqual([
      { dedupeKey: 'a:state:degraded', kind: 'degraded', checkId: 'a', at: T0 },
    ]);
  });

  it('dailyHistory uses worst non-unknown status per UTC day', () => {
    const s = mem();
    s.recordResult(res('degraded', '2026-11-03T10:00:00.000Z'));
    s.recordResult(res('operational', '2026-11-03T11:00:00.000Z'));
    s.recordResult(res('unknown', '2026-11-04T10:00:00.000Z', { error: 'x' }));
    const h = s.dailyHistory(7, new Date('2026-11-04T12:00:00Z')).get('a');
    expect(h).toEqual([
      { day: '2026-11-03', status: 'degraded' },
      { day: '2026-11-04', status: 'unknown' },
    ]);
  });

  it('prune deletes old history, old alerts and old resolved incidents; keeps open ones', () => {
    const s = mem();
    const now = new Date('2026-11-04T12:00:00Z');
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    s.recordResult(res('operational', ago(31)));
    s.recordResult(res('operational', ago(29)));
    // resolved long ago
    s.recordResult(res('degraded', ago(40), { checkId: 'b', incidents: [inc] }));
    s.recordResult(res('operational', ago(35), { checkId: 'b' }));
    // open and old
    s.recordResult(res('degraded', ago(40), { checkId: 'c', incidents: [inc] }));
    // resolved recently
    s.recordResult(res('degraded', ago(40), { checkId: 'd', incidents: [inc] }));
    s.recordResult(res('operational', ago(5), { checkId: 'd' }));
    const ev = (at: string, key: string): AlertEvent =>
      ({ kind: 'degraded', checkId: 'a', checkName: 'A', from: null, to: 'degraded', since: at, at, incidents: [], components: [], dedupeKey: key });
    s.logAlert(ev(ago(31), 'old'));
    s.logAlert(ev(ago(1), 'new'));

    expect(s.prune(30, now)).toBe(5);
    expect(s.recentAlerts(10).map((a) => a.dedupeKey)).toEqual(['new']);
    expect(s.incidents('b')).toHaveLength(0);
    expect(s.incidents('c', { openOnly: true })).toHaveLength(1);
    expect(s.incidents('d')).toHaveLength(1);
    expect(s.dailyHistory(60, now).get('a')).toHaveLength(1);
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

    it('logAlert returns the row id; a new alert is pending with its full event payload', () => {
      const s = mem();
      const e = ev(hoursAgo(1), 'k1');
      const id = s.logAlert(e);
      expect(typeof id).toBe('number');
      expect(s.pendingAlerts(opts)).toEqual([{ id, attempts: 0, event: e }]);
    });

    it('markAlertSent removes it from pending', () => {
      const s = mem();
      const id = s.logAlert(ev(hoursAgo(1), 'k1'));
      s.markAlertSent(id, NOW);
      expect(s.pendingAlerts(opts)).toEqual([]);
    });

    it('markAlertFailed increments attempts and keeps it pending until the cap', () => {
      const s = mem();
      const id = s.logAlert(ev(hoursAgo(1), 'k1'));
      for (let i = 1; i <= 4; i++) {
        s.markAlertFailed(id, `boom ${i}`);
        expect(s.pendingAlerts(opts).map((p) => p.attempts)).toEqual([i]);
      }
      s.markAlertFailed(id, 'boom 5');
      expect(s.pendingAlerts(opts)).toEqual([]);
    });

    it('excludes alerts older than minCreatedAt and returns the rest oldest first', () => {
      const s = mem();
      s.logAlert(ev(hoursAgo(25), 'too-old', 'x'));
      const newer = s.logAlert(ev(hoursAgo(1), 'newer', 'b'));
      const older = s.logAlert(ev(hoursAgo(23), 'older', 'c'));
      expect(s.pendingAlerts(opts).map((p) => p.id)).toEqual([older, newer]);
    });

    it('drops an unsent alert once a newer alert exists for the same check (no stale degraded after recovered)', () => {
      const s = mem();
      s.logAlert(ev(hoursAgo(3), 'a:state:major_outage'));
      const recovered = s.logAlert(ev(hoursAgo(2), 'a:state:operational', 'a', 'recovered'));
      s.markAlertSent(recovered, NOW);
      const other = s.logAlert(ev(hoursAgo(3), 'b:state:major_outage', 'b'));
      expect(s.pendingAlerts(opts).map((p) => p.id)).toEqual([other]);

      // The newest alert for a check stays retryable while it is unsent.
      const worse = s.logAlert(ev(hoursAgo(1), 'a:state:degraded', 'a'));
      expect(s.pendingAlerts(opts).map((p) => p.id)).toEqual([other, worse]);
    });

    it('prune deletes old alerts whether sent or not', () => {
      const s = mem();
      const sent = s.logAlert(ev(hoursAgo(31 * 24), 'old-sent'));
      s.markAlertSent(sent, NOW);
      s.logAlert(ev(hoursAgo(31 * 24), 'old-unsent'));
      s.logAlert(ev(hoursAgo(1), 'new'));
      s.prune(30, NOW);
      expect(s.recentAlerts(10).map((a) => a.dedupeKey)).toEqual(['new']);
    });

    it('migrates an old-schema alerts table idempotently without re-sending its rows', () => {
      const dir = mkdtempSync(join(tmpdir(), 'vsm-'));
      dirs.push(dir);
      const file = join(dir, 'old.db');
      const old = new Database(file);
      old.exec(`CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        check_id TEXT NOT NULL,
        at TEXT NOT NULL,
        event_json TEXT NOT NULL
      )`);
      const e = ev(hoursAgo(1), 'pre-outbox');
      old.prepare('INSERT INTO alerts (dedupe_key, kind, check_id, at, event_json) VALUES (?, ?, ?, ?, ?)')
        .run(e.dedupeKey, e.kind, e.checkId, e.at, JSON.stringify(e));
      old.close();

      const s1 = new Store(file);
      stores.push(s1);
      s1.close();
      const s = new Store(file);
      stores.push(s);
      const inspect = new Database(file, { readonly: true });
      const cols = (inspect.prepare('PRAGMA table_info(alerts)').all() as Array<{ name: string }>).map((c) => c.name);
      inspect.close();
      expect(cols).toEqual(expect.arrayContaining(['sent_at', 'attempts', 'last_error']));
      // Rows written before the outbox existed already had their one delivery attempt.
      expect(s.pendingAlerts(opts)).toEqual([]);
      const id = s.logAlert(ev(hoursAgo(1), 'post-outbox'));
      expect(s.pendingAlerts(opts).map((p) => p.id)).toEqual([id]);
    });
  });

  it('creates the parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsm-'));
    dirs.push(dir);
    const p = join(dir, 'nested', 'dir', 'x.db');
    const s = new Store(p);
    stores.push(s);
    expect(existsSync(p)).toBe(true);
  });
});
