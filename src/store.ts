import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client, Config, InStatement } from '@libsql/client';
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
CREATE INDEX IF NOT EXISTS idx_history_time ON check_history (checked_at);
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
  event_json TEXT NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_check_time ON alerts (check_id, at);
CREATE TABLE IF NOT EXISTS poller_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lock_until INTEGER,
  lock_owner TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_pruned_at INTEGER,
  cycles INTEGER NOT NULL DEFAULT 0
);
`;

const OUTBOX_COLUMNS = ['sent_at', 'attempts', 'last_error'] as const;

export interface PendingAlert {
  id: number;
  attempts: number;
  event: AlertEvent;
}

/** Poll-cycle bookkeeping shared by every process that uses the database. */
export interface PollerRecord {
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  cycles: number;
  /** True while a cycle holds an unexpired lock. */
  running: boolean;
}

export interface StoreOptions {
  /** `file:<path>`, `:memory:`, or a remote libSQL/Turso URL (`libsql://…`, `https://…`). */
  url: string;
  authToken?: string;
  /** Aborts each request to a remote database after this long. Unset = no limit. Ignored for local databases. */
  requestTimeoutMs?: number;
}

/** The local path behind a `file:` URL, or undefined for memory and remote databases. */
export function localDbPath(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  if (url.startsWith('file://')) return fileURLToPath(url);
  const path = url.slice('file:'.length).split('?')[0]!;
  return path === '' || path === ':memory:' ? undefined : path;
}

/** True for databases the native driver must open: `file:` URLs and `:memory:`. */
export function isLocalDbUrl(url: string): boolean {
  return url === ':memory:' || url.startsWith('file:');
}

/**
 * Local databases use the native driver. Remote ones use the pure-JS web client (HTTP/WebSocket),
 * so a serverless bundle never loads libsql's native binary, which it resolves with a dynamic
 * require that bundlers cannot trace.
 */
async function connect(opts: StoreOptions): Promise<Client> {
  const config: Config = { url: opts.url, ...(opts.authToken ? { authToken: opts.authToken } : {}) };
  if (isLocalDbUrl(opts.url)) return (await import('@libsql/client')).createClient(config);
  const { requestTimeoutMs } = opts;
  if (requestTimeoutMs !== undefined) {
    // The web client calls this with a single Request; a hung database round trip must not eat the cycle.
    config.fetch = (req: Request) => fetch(req, { signal: AbortSignal.timeout(requestTimeoutMs) });
  }
  return (await import('@libsql/client/web')).createClient(config);
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export class Store {
  private constructor(private readonly db: Client) {}

  /** Opens the database and applies the schema and migrations. Idempotent; safe on every cold start. */
  static async open(opts: StoreOptions): Promise<Store> {
    const path = localDbPath(opts.url);
    if (path !== undefined) mkdirSync(dirname(path), { recursive: true });
    const db = await connect(opts);
    const store = new Store(db);
    try {
      // WAL only applies to local files; remote databases manage their own journal.
      if (path !== undefined) await db.execute('PRAGMA journal_mode = WAL');
      await db.executeMultiple(SCHEMA);
      await store.migrateAlerts();
    } catch (err) {
      db.close();
      throw err;
    }
    return store;
  }

  /** Adds the outbox columns to an `alerts` table created by a version without them. Idempotent. */
  private async migrateAlerts(): Promise<void> {
    const cols = await this.alertColumns();
    const steps: InStatement[] = [];
    if (!cols.has('sent_at')) {
      steps.push('ALTER TABLE alerts ADD COLUMN sent_at INTEGER');
      // Rows from before the outbox already had their single delivery attempt; never re-send them.
      steps.push("UPDATE alerts SET sent_at = COALESCE(CAST(strftime('%s', at) AS INTEGER) * 1000, 0)");
    }
    if (!cols.has('attempts')) steps.push('ALTER TABLE alerts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('last_error')) steps.push('ALTER TABLE alerts ADD COLUMN last_error TEXT');
    if (steps.length === 0) return;
    try {
      await this.db.batch(steps, 'write');
    } catch (err) {
      // Two cold starts can migrate at once; the loser's batch rolls back on "duplicate column name".
      // That is fine as long as the winner's migration is now in place.
      const now = await this.alertColumns();
      if (!OUTBOX_COLUMNS.every((c) => now.has(c))) throw err;
    }
  }

  private async alertColumns(): Promise<Set<string>> {
    const info = await this.db.execute('PRAGMA table_info(alerts)');
    return new Set(info.rows.map((c) => String(c['name'])));
  }

  /** Statements that record one result: history row, latest result, and incident reconciliation. */
  private recordStatements(r: CheckResult): InStatement[] {
    const stmts: InStatement[] = [
      {
        sql: 'INSERT INTO check_history (check_id, checked_at, status, summary, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
        args: [r.checkId, r.checkedAt, r.status, r.summary ?? null, r.error ?? null, r.durationMs],
      },
      {
        sql: 'INSERT OR REPLACE INTO check_latest (check_id, result_json) VALUES (?, ?)',
        args: [r.checkId, JSON.stringify(r)],
      },
    ];
    // A fetch failure says nothing about incidents: keep them as they were.
    if (r.status === 'unknown') return stmts;
    for (const i of r.incidents) {
      stmts.push({
        sql: `INSERT INTO incidents (check_id, incident_id, title, url, status, started_at, last_seen_at, resolved_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
              ON CONFLICT (check_id, incident_id) DO UPDATE SET
                title = excluded.title, url = excluded.url, status = excluded.status,
                last_seen_at = excluded.last_seen_at, resolved_at = NULL`,
        args: [r.checkId, i.id, i.title, i.url ?? null, i.status, i.startedAt ?? r.checkedAt, r.checkedAt],
      });
    }
    stmts.push({
      sql: `UPDATE incidents SET resolved_at = ?
            WHERE check_id = ? AND resolved_at IS NULL
              AND incident_id NOT IN (SELECT value FROM json_each(?))`,
      args: [r.checkedAt, r.checkId, JSON.stringify(r.incidents.map((i) => i.id))],
    });
    return stmts;
  }

  /** Records one result atomically. */
  async recordResult(r: CheckResult): Promise<void> {
    await this.db.batch(this.recordStatements(r), 'write');
  }

  /**
   * Records a result, saves the check's next alert state and logs its alerts as unsent, all in one
   * atomic round trip. Returns the outbox row id of each event, in order.
   */
  async commitCycleResult(r: CheckResult, state: AlertState, events: AlertEvent[]): Promise<number[]> {
    const record = this.recordStatements(r);
    const stmts: InStatement[] = [
      ...record,
      this.saveAlertStateStatement(r.checkId, state),
      ...events.map((e) => this.logAlertStatement(e)),
    ];
    const results = await this.db.batch(stmts, 'write');
    return results.slice(record.length + 1).map((res) => Number(res.lastInsertRowid));
  }

  async latestResults(): Promise<Map<string, CheckResult>> {
    const res = await this.db.execute('SELECT check_id, result_json FROM check_latest');
    return new Map(res.rows.map((row) => [String(row['check_id']), JSON.parse(String(row['result_json'])) as CheckResult]));
  }

  async getAlertState(checkId: string): Promise<AlertState | undefined> {
    const res = await this.db.execute({ sql: 'SELECT state_json FROM alert_state WHERE check_id = ?', args: [checkId] });
    const row = res.rows[0];
    return row ? (JSON.parse(String(row['state_json'])) as AlertState) : undefined;
  }

  /** Every saved alert state, keyed by check id. */
  async alertStates(): Promise<Map<string, AlertState>> {
    const res = await this.db.execute('SELECT check_id, state_json FROM alert_state');
    return new Map(res.rows.map((row) => [String(row['check_id']), JSON.parse(String(row['state_json'])) as AlertState]));
  }

  private saveAlertStateStatement(checkId: string, s: AlertState): InStatement {
    return {
      sql: 'INSERT OR REPLACE INTO alert_state (check_id, state_json) VALUES (?, ?)',
      args: [checkId, JSON.stringify(s)],
    };
  }

  async saveAlertState(checkId: string, s: AlertState): Promise<void> {
    await this.db.execute(this.saveAlertStateStatement(checkId, s));
  }

  private logAlertStatement(e: AlertEvent): InStatement {
    return {
      sql: 'INSERT INTO alerts (dedupe_key, kind, check_id, at, event_json) VALUES (?, ?, ?, ?, ?)',
      args: [e.dedupeKey, e.kind, e.checkId, e.at, JSON.stringify(e)],
    };
  }

  /** Persists the alert with its full payload as unsent; returns the row id. */
  async logAlert(e: AlertEvent): Promise<number> {
    const res = await this.db.execute(this.logAlertStatement(e));
    return Number(res.lastInsertRowid);
  }

  async markAlertSent(id: number, now: Date): Promise<void> {
    await this.db.execute({ sql: 'UPDATE alerts SET sent_at = ? WHERE id = ?', args: [now.getTime(), id] });
  }

  async markAlertFailed(id: number, error: string): Promise<void> {
    await this.db.execute({
      sql: 'UPDATE alerts SET attempts = attempts + 1, last_error = ? WHERE id = ?',
      args: [error, id],
    });
  }

  /**
   * Unsent alerts with fewer than `maxAttempts` failed attempts, created at or after `minCreatedAt`, oldest first.
   * An alert is stale, and never retried, once a newer alert exists for the same check: re-sending it would
   * report an old state (e.g. "degraded" after "recovered"). A check emits at most one alert per cycle.
   */
  async pendingAlerts(opts: { maxAttempts: number; minCreatedAt: Date }): Promise<PendingAlert[]> {
    const res = await this.db.execute({
      sql: `SELECT a.id, a.attempts, a.event_json FROM alerts a
            WHERE a.sent_at IS NULL AND a.attempts < ? AND a.at >= ?
              AND NOT EXISTS (
                SELECT 1 FROM alerts b
                WHERE b.check_id = a.check_id AND (b.at > a.at OR (b.at = a.at AND b.id > a.id))
              )
            ORDER BY a.at, a.id`,
      args: [opts.maxAttempts, opts.minCreatedAt.toISOString()],
    });
    return res.rows.map((r) => ({
      id: Number(r['id']),
      attempts: Number(r['attempts']),
      event: JSON.parse(String(r['event_json'])) as AlertEvent,
    }));
  }

  async recentAlerts(limit: number): Promise<Array<{ dedupeKey: string; kind: AlertKind; checkId: string; at: string }>> {
    const res = await this.db.execute({
      sql: 'SELECT dedupe_key, kind, check_id, at FROM alerts ORDER BY at DESC, id DESC LIMIT ?',
      args: [limit],
    });
    return res.rows.map((r) => ({
      dedupeKey: String(r['dedupe_key']),
      kind: String(r['kind']) as AlertKind,
      checkId: String(r['check_id']),
      at: String(r['at']),
    }));
  }

  private static toIncident(r: IncidentRow): StoredIncident {
    return {
      checkId: r.check_id,
      incidentId: r.incident_id,
      title: r.title,
      ...(r.url !== null ? { url: r.url } : {}),
      status: r.status,
      startedAt: r.started_at,
      lastSeenAt: r.last_seen_at,
      resolvedAt: r.resolved_at,
    };
  }

  private static incidentRow(row: Record<string, unknown>): IncidentRow {
    return {
      check_id: String(row['check_id']),
      incident_id: String(row['incident_id']),
      title: String(row['title']),
      url: str(row['url']),
      status: String(row['status']) as Status,
      started_at: String(row['started_at']),
      last_seen_at: String(row['last_seen_at']),
      resolved_at: str(row['resolved_at']),
    };
  }

  async incidents(checkId: string, opts?: { openOnly?: boolean }): Promise<StoredIncident[]> {
    const sql = `SELECT * FROM incidents WHERE check_id = ?${
      opts?.openOnly ? ' AND resolved_at IS NULL' : ''
    } ORDER BY started_at DESC, incident_id`;
    const res = await this.db.execute({ sql, args: [checkId] });
    return res.rows.map((row) => Store.toIncident(Store.incidentRow(row)));
  }

  /** Open incidents of every check, keyed by check id, newest first. */
  async openIncidents(): Promise<Map<string, StoredIncident[]>> {
    const res = await this.db.execute(
      'SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY check_id, started_at DESC, incident_id',
    );
    const out = new Map<string, StoredIncident[]>();
    for (const row of res.rows) {
      const i = Store.toIncident(Store.incidentRow(row));
      let list = out.get(i.checkId);
      if (!list) out.set(i.checkId, (list = []));
      list.push(i);
    }
    return out;
  }

  async dailyHistory(days: number, now: Date): Promise<Map<string, Array<{ day: string; status: Status }>>> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    const res = await this.db.execute({
      sql: 'SELECT check_id, substr(checked_at, 1, 10) AS day, status FROM check_history WHERE checked_at >= ?',
      args: [start.toISOString()],
    });
    const worst = new Map<string, Map<string, Status>>();
    for (const row of res.rows) {
      const checkId = String(row['check_id']);
      const day = String(row['day']);
      const status = String(row['status']) as Status;
      let perDay = worst.get(checkId);
      if (!perDay) worst.set(checkId, (perDay = new Map()));
      const cur = perDay.get(day);
      if (cur === undefined || (cur === 'unknown' && status !== 'unknown') || (status !== 'unknown' && SEVERITY[status] > SEVERITY[cur])) {
        perDay.set(day, status);
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

  async prune(retentionDays: number, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const [history] = await this.db.batch(
      [
        { sql: 'DELETE FROM check_history WHERE checked_at < ?', args: [cutoff] },
        { sql: 'DELETE FROM alerts WHERE at < ?', args: [cutoff] },
        { sql: 'DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?', args: [cutoff] },
      ],
      'write',
    );
    return history!.rowsAffected;
  }

  /**
   * Takes the cross-process poll lock until `now + ttlMs` and records the cycle start. Returns the lock's owner
   * token, or null, changing nothing, while another holder's lock is unexpired. Two serverless invocations can
   * overlap; only one polls.
   */
  async tryStartCycle(now: Date, ttlMs: number): Promise<string | null> {
    const owner = randomUUID();
    const res = await this.db.execute({
      sql: `INSERT INTO poller_state (id, lock_until, lock_owner, last_started_at) VALUES (1, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              lock_until = excluded.lock_until, lock_owner = excluded.lock_owner, last_started_at = excluded.last_started_at
            WHERE poller_state.lock_until IS NULL OR poller_state.lock_until <= ?`,
      args: [now.getTime() + ttlMs, owner, now.toISOString(), now.getTime()],
    });
    return res.rowsAffected === 1 ? owner : null;
  }

  /**
   * Records a completed cycle and releases the poll lock if `owner` still holds it. A cycle that outlived its
   * TTL may finish after another process took the lock over; that newer lock is left alone.
   */
  async finishCycle(now: Date, owner: string): Promise<void> {
    await this.db.execute({
      sql: `UPDATE poller_state SET
              lock_until = CASE WHEN lock_owner = ? THEN NULL ELSE lock_until END,
              lock_owner = CASE WHEN lock_owner = ? THEN NULL ELSE lock_owner END,
              last_completed_at = ?, cycles = cycles + 1
            WHERE id = 1`,
      args: [owner, owner, now.toISOString()],
    });
  }

  /** Claims the hourly prune for this cycle: true at most once per `everyMs` across all processes. */
  async claimPrune(now: Date, everyMs: number): Promise<boolean> {
    const res = await this.db.execute({
      sql: 'UPDATE poller_state SET last_pruned_at = ? WHERE id = 1 AND (last_pruned_at IS NULL OR last_pruned_at <= ?)',
      args: [now.getTime(), now.getTime() - everyMs],
    });
    return res.rowsAffected === 1;
  }

  async pollerRecord(now: Date): Promise<PollerRecord> {
    const res = await this.db.execute('SELECT lock_until, last_started_at, last_completed_at, cycles FROM poller_state WHERE id = 1');
    const row = res.rows[0];
    if (!row) return { lastCycleStartedAt: null, lastCycleCompletedAt: null, cycles: 0, running: false };
    const lockUntil = row['lock_until'] === null ? null : Number(row['lock_until']);
    return {
      lastCycleStartedAt: str(row['last_started_at']),
      lastCycleCompletedAt: str(row['last_completed_at']),
      cycles: Number(row['cycles']),
      running: lockUntil !== null && lockUntil > now.getTime(),
    };
  }

  close(): void {
    this.db.close();
  }
}
