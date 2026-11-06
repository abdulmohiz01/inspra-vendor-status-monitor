import { decideAlerts, initialAlertState } from './alerts/decide.js';
import type { AlertEvent } from './alerts/decide.js';
import type { DeliveryResult, Notifier } from './alerts/notifier.js';
import type { AppConfig } from './config.js';
import type { Logger } from './log.js';
import { runCheck } from './run-check.js';
import type { PendingAlert, Store } from './store.js';
import type { Check, CheckResult, FetchFn } from './types.js';

const PRUNE_EVERY_MS = 60 * 60 * 1000;
const SEND_CONCURRENCY = 4;
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long a budgeted (serverless) cycle holds the cross-process lock; an invocation killed mid-cycle frees it
 * after this. Comfortably above the budget and the function's maxDuration.
 */
export const CYCLE_LOCK_TTL_MS = 60_000;
/** Lock TTL for an unbudgeted (long-running) cycle, whose fetch timeout alone may be up to 60 s. */
export const LONG_CYCLE_LOCK_TTL_MS = 5 * 60_000;

/** An alert to send and its outbox row. */
interface Outgoing {
  id: number;
  event: AlertEvent;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs `fn` over `items` with at most `limit` in flight; a failure never stops the others. */
async function settleBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch {
        /* fn reports its own failures */
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function nextDelayMs(intervalSeconds: number, random: () => number): number {
  return intervalSeconds * 1000 + Math.floor(random() * Math.min(intervalSeconds * 100, 15000));
}

export interface Liveness {
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  cycles: number;
  running: boolean;
  intervalSeconds: number;
}

export interface CycleReport {
  /** Set when no cycle ran: one is already running in this process, or another process holds the lock. */
  skipped?: 'running' | 'locked';
  startedAt: string;
  durationMs: number;
  results: CheckResult[];
  alerts: { sent: number; failed: number; deferred: number };
}

/**
 * Bounds a cycle's wall-clock time (for serverless invocations). A send only starts while
 * `sendTimeoutMs` still fits inside `budgetMs`; the rest stay unsent and the next cycle retries them.
 */
export interface CycleBudget {
  budgetMs: number;
  sendTimeoutMs: number;
}

export interface PollerDeps {
  checks: Check[];
  store: Store;
  notifier: Notifier;
  config: Pick<
    AppConfig,
    'pollIntervalSeconds' | 'fetchTimeoutMs' | 'alertReminderMinutes' | 'unknownAlertThreshold' | 'historyRetentionDays'
  >;
  log: Logger;
  fetch?: FetchFn;
  now?: () => Date;
  random?: () => number;
  budget?: CycleBudget;
}

export class Poller {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly fetchFn: FetchFn;
  private current: Promise<CycleReport> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.fetchFn = deps.fetch ?? fetch;
  }

  runCycle(): Promise<CycleReport> {
    if (this.current) {
      this.deps.log.warn('poll cycle skipped: previous cycle still running');
      return Promise.resolve(this.skippedReport('running'));
    }
    const p = this.execute().finally(() => {
      this.current = null;
    });
    this.current = p;
    return p;
  }

  private skippedReport(skipped: 'running' | 'locked'): CycleReport {
    return {
      skipped,
      startedAt: this.now().toISOString(),
      durationMs: 0,
      results: [],
      alerts: { sent: 0, failed: 0, deferred: 0 },
    };
  }

  private async execute(): Promise<CycleReport> {
    const { checks, store, config, log } = this.deps;
    const started = this.now();
    const lockTtlMs = this.deps.budget ? CYCLE_LOCK_TTL_MS : LONG_CYCLE_LOCK_TTL_MS;
    const owner = await store.tryStartCycle(started, lockTtlMs);
    if (owner === null) {
      log.warn('poll cycle skipped: another process holds the poll lock');
      return this.skippedReport('locked');
    }
    const policy = { unknownAlertThreshold: config.unknownAlertThreshold, reminderMinutes: config.alertReminderMinutes };
    const tally = { sent: 0, failed: 0, deferred: 0 };

    try {
      // Retries only touch earlier alerts, so they run alongside the vendor fetches.
      const [, results] = await Promise.all([
        this.retryPending(started, tally),
        Promise.all(
          checks.map((check) =>
            runCheck(check, { timeoutMs: config.fetchTimeoutMs, fetch: this.fetchFn, now: this.now }),
          ),
        ),
      ]);

      let states: Map<string, ReturnType<typeof initialAlertState>> = new Map();
      try {
        states = await store.alertStates();
      } catch (err) {
        log.error('failed to read alert states', { error: errMsg(err) });
        return this.report(started, results, tally);
      }

      // Each check's result, next alert state and outbox rows commit atomically before any send starts.
      // If a commit fails nothing is saved, so the next cycle decides (and alerts) again. Checks touch
      // disjoint rows, so their commits run concurrently: one round trip of latency, not one per check.
      const committed = await Promise.all(
        results.map(async (result, idx): Promise<Outgoing[]> => {
          const check = checks[idx]!;
          try {
            const prev = states.get(check.id) ?? initialAlertState();
            const { events, next } = decideAlerts(check, prev, result, policy);
            const ids = await store.commitCycleResult(result, next, events);
            return events.map((event, i) => ({ id: ids[i]!, event }));
          } catch (err) {
            log.error('failed to process check result', { checkId: check.id, error: errMsg(err) });
            return [];
          }
        }),
      );
      await this.sendAll(committed.flat(), started, tally);

      await this.maybePrune();
      return this.report(started, results, tally);
    } finally {
      try {
        await store.finishCycle(this.now(), owner);
      } catch (err) {
        log.error('failed to record cycle completion', { error: errMsg(err) });
      }
    }
  }

  private report(started: Date, results: CheckResult[], alerts: CycleReport['alerts']): CycleReport {
    return {
      startedAt: started.toISOString(),
      durationMs: this.now().getTime() - started.getTime(),
      results,
      alerts,
    };
  }

  /** Sends with bounded concurrency; under a budget, a send that might not finish in time is deferred. */
  private async sendAll(items: Outgoing[], started: Date, tally: CycleReport['alerts']): Promise<void> {
    const { budget } = this.deps;
    await settleBounded(items, SEND_CONCURRENCY, async (o) => {
      if (budget && this.now().getTime() - started.getTime() + budget.sendTimeoutMs > budget.budgetMs) {
        tally.deferred += 1;
        return;
      }
      const ok = await this.deliver(o);
      if (ok) tally.sent += 1;
      else tally.failed += 1;
    });
  }

  /** Re-sends unsent alerts from earlier cycles (within the attempt cap and age cutoff). */
  private async retryPending(started: Date, tally: CycleReport['alerts']): Promise<void> {
    const { store, log } = this.deps;
    let pending: PendingAlert[];
    try {
      pending = await store.pendingAlerts({
        maxAttempts: RETRY_MAX_ATTEMPTS,
        minCreatedAt: new Date(started.getTime() - RETRY_MAX_AGE_MS),
      });
    } catch (err) {
      log.error('failed to read pending alerts', { error: errMsg(err) });
      return;
    }
    for (const p of pending) {
      log.info('retrying alert', {
        id: p.id,
        checkId: p.event.checkId,
        dedupeKey: p.event.dedupeKey,
        kind: p.event.kind,
        attempts: p.attempts,
      });
    }
    await this.sendAll(
      pending.map((p) => ({ id: p.id, event: p.event })),
      started,
      tally,
    );
  }

  /** Sends one alert and records the outcome on its outbox row. Never throws; resolves to delivery success. */
  private async deliver({ id, event: e }: Outgoing): Promise<boolean> {
    const { store, notifier, log } = this.deps;
    let result: DeliveryResult;
    try {
      result = await notifier.notify(e);
    } catch (err) {
      log.error('notify failed', { checkId: e.checkId, dedupeKey: e.dedupeKey, error: errMsg(err) });
      result = { ok: false, error: errMsg(err) };
    }
    try {
      if (result.ok) await store.markAlertSent(id, this.now());
      else await store.markAlertFailed(id, result.error ?? 'delivery failed');
    } catch (err) {
      log.error('failed to record alert delivery', { id, checkId: e.checkId, dedupeKey: e.dedupeKey, error: errMsg(err) });
    }
    return result.ok;
  }

  /** Prunes at most once per hour, judged by the persisted last-prune time so serverless instances agree. */
  private async maybePrune(): Promise<void> {
    const now = this.now();
    try {
      if (!(await this.deps.store.claimPrune(now, PRUNE_EVERY_MS))) return;
      const deleted = await this.deps.store.prune(this.deps.config.historyRetentionDays, now);
      this.deps.log.info('pruned history', { deleted });
    } catch (err) {
      this.deps.log.error('prune failed', { error: errMsg(err) });
    }
  }

  /** Long-running (non-serverless) mode: run a cycle now, then one every interval plus jitter. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async (): Promise<void> => {
      try {
        await this.runCycle();
      } catch (err) {
        this.deps.log.error('poll cycle failed', { error: errMsg(err) });
      }
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), nextDelayMs(this.deps.config.pollIntervalSeconds, this.random));
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.current) await this.current.catch(() => undefined);
  }

  /** Cycle bookkeeping from the database, so every process (and serverless instance) reports the same. */
  async liveness(): Promise<Liveness> {
    const rec = await this.deps.store.pollerRecord(this.now());
    return { ...rec, intervalSeconds: this.deps.config.pollIntervalSeconds };
  }

  /** Healthy when a cycle completed within two intervals plus slack. A database that never completed one is not. */
  isHealthy(l: Pick<Liveness, 'lastCycleCompletedAt'>, now: Date = this.now()): boolean {
    if (l.lastCycleCompletedAt === null) return false;
    const { pollIntervalSeconds, fetchTimeoutMs } = this.deps.config;
    const windowMs = (2 * pollIntervalSeconds + fetchTimeoutMs / 1000 + 30) * 1000;
    return now.getTime() - Date.parse(l.lastCycleCompletedAt) <= windowMs;
  }
}
