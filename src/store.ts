import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { AlertEvent, AlertKind, AlertState } from './alerts/decide.js';
import { SEVERITY } from './types.js';
import type { CheckResult, Status } from './types.js';

export interface StoredIncident {
  checkId: string;
  incidentId: string;
  title: string;
  url?: string;
  status: Status;
  startedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

interface IncidentRow {
  check_id: string;
  incident_id: string;
  title: string;
  url: string | null;
  status: Status;
  started_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS check_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_check_time ON check_history (check_id, checked_at);
CREATE TABLE IF NOT EXISTS check_latest (
  check_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  check_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (check_id, incident_id)
);
CREATE TABLE IF NOT EXISTS alert_state (
  check_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  check_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event_json TEXT NOT NULL
);
`;

export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  recordResult(r: CheckResult): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO check_history (check_id, checked_at, status, summary, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(r.checkId, r.checkedAt, r.status, r.summary ?? null, r.error ?? null, r.durationMs);
      this.db
        .prepare('INSERT OR REPLACE INTO check_latest (check_id, result_json) VALUES (?, ?)')
        .run(r.checkId, JSON.stringify(r));
      if (r.status !== 'unknown') this.reconcileIncidents(r);
    });
    tx();
  }

  private reconcileIncidents(r: CheckResult): void {
    const upsert = this.db.prepare(
      `INSERT INTO incidents (check_id, incident_id, title, url, status, started_at, last_seen_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (check_id, incident_id) DO UPDATE SET
         title = excluded.title, url = excluded.url, status = excluded.status,
         last_seen_at = excluded.last_seen_at, resolved_at = NULL`,
    );
    for (const i of r.incidents) {
      upsert.run(r.checkId, i.id, i.title, i.url ?? null, i.status, i.startedAt ?? r.checkedAt, r.checkedAt);
    }
    const seen = new Set(r.incidents.map((i) => i.id));
    const open = this.db
      .prepare('SELECT incident_id FROM incidents WHERE check_id = ? AND resolved_at IS NULL')
      .all(r.checkId) as Array<{ incident_id: string }>;
    const resolve = this.db.prepare(
      'UPDATE incidents SET resolved_at = ? WHERE check_id = ? AND incident_id = ?',
    );
    for (const o of open) {
      if (!seen.has(o.incident_id)) resolve.run(r.checkedAt, r.checkId, o.incident_id);
    }
  }

  latestResults(): Map<string, CheckResult> {
    const rows = this.db.prepare('SELECT check_id, result_json FROM check_latest').all() as Array<{
      check_id: string;
      result_json: string;
    }>;
    return new Map(rows.map((row) => [row.check_id, JSON.parse(row.result_json) as CheckResult]));
  }

  getAlertState(checkId: string): AlertState | undefined {
    const row = this.db.prepare('SELECT state_json FROM alert_state WHERE check_id = ?').get(checkId) as
      | { state_json: string }
      | undefined;
    return row ? (JSON.parse(row.state_json) as AlertState) : undefined;
  }

  saveAlertState(checkId: string, s: AlertState): void {
    this.db
      .prepare('INSERT OR REPLACE INTO alert_state (check_id, state_json) VALUES (?, ?)')
      .run(checkId, JSON.stringify(s));
  }

  logAlert(e: AlertEvent): void {
    this.db
      .prepare('INSERT INTO alerts (dedupe_key, kind, check_id, at, event_json) VALUES (?, ?, ?, ?, ?)')
      .run(e.dedupeKey, e.kind, e.checkId, e.at, JSON.stringify(e));
  }

  recentAlerts(limit: number): Array<{ dedupeKey: string; kind: AlertKind; checkId: string; at: string }> {
    const rows = this.db
      .prepare('SELECT dedupe_key, kind, check_id, at FROM alerts ORDER BY at DESC, id DESC LIMIT ?')
      .all(limit) as Array<{ dedupe_key: string; kind: AlertKind; check_id: string; at: string }>;
    return rows.map((r) => ({ dedupeKey: r.dedupe_key, kind: r.kind, checkId: r.check_id, at: r.at }));
  }

  incidents(checkId: string, opts?: { openOnly?: boolean }): StoredIncident[] {
    const sql = `SELECT * FROM incidents WHERE check_id = ?${
      opts?.openOnly ? ' AND resolved_at IS NULL' : ''
    } ORDER BY started_at DESC, incident_id`;
    const rows = this.db.prepare(sql).all(checkId) as IncidentRow[];
    return rows.map((r) => ({
      checkId: r.check_id,
      incidentId: r.incident_id,
      title: r.title,
      ...(r.url !== null ? { url: r.url } : {}),
      status: r.status,
      startedAt: r.started_at,
      lastSeenAt: r.last_seen_at,
      resolvedAt: r.resolved_at,
    }));
  }

  dailyHistory(days: number, now: Date): Map<string, Array<{ day: string; status: Status }>> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    const rows = this.db
      .prepare(
        'SELECT check_id, substr(checked_at, 1, 10) AS day, status FROM check_history WHERE checked_at >= ? ORDER BY checked_at',
      )
      .all(start.toISOString()) as Array<{ check_id: string; day: string; status: Status }>;
    const worst = new Map<string, Map<string, Status>>();
    for (const r of rows) {
      let perDay = worst.get(r.check_id);
      if (!perDay) worst.set(r.check_id, (perDay = new Map()));
      const cur = perDay.get(r.day);
      if (cur === undefined || (cur === 'unknown' && r.status !== 'unknown') || (r.status !== 'unknown' && SEVERITY[r.status] > SEVERITY[cur])) {
        perDay.set(r.day, r.status);
      }
    }
    const out = new Map<string, Array<{ day: string; status: Status }>>();
    for (const [id, perDay] of worst) {
      out.set(
        id,
        [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, status]) => ({ day, status })),
      );
    }
    return out;
  }

  prune(retentionDays: number, now: Date): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const tx = this.db.transaction(() => {
      const deleted = this.db.prepare('DELETE FROM check_history WHERE checked_at < ?').run(cutoff).changes;
      this.db.prepare('DELETE FROM alerts WHERE at < ?').run(cutoff);
      this.db.prepare('DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(cutoff);
      return deleted;
    });
    return tx();
  }

  close(): void {
    this.db.close();
  }
}
