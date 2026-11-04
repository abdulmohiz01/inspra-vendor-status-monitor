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

/** An alert to send; `id` is its outbox row, absent if logging it failed. */
interface Outgoing {
  id: number | undefined;
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
  startedAt: string;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  cycles: number;
  running: boolean;
  intervalSeconds: number;
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
}

export class Poller {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly fetchFn: FetchFn;
  private readonly startedAt: string;
  private lastCycleStartedAt: string | null = null;
  private lastCycleCompletedAt: string | null = null;
  private cycles = 0;
  private current: Promise<CheckResult[]> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private lastPruneAt: number | null = null;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.fetchFn = deps.fetch ?? fetch;
    this.startedAt = this.now().toISOString();
  }

  runCycle(): Promise<CheckResult[]> {
    if (this.current) {
      this.deps.log.warn('poll cycle skipped: previous cycle still running');
      return Promise.resolve([]);
    }
    const p = this.execute().finally(() => {
      this.current = null;
    });
    this.current = p;
    return p;
  }

  private async execute(): Promise<CheckResult[]> {
    const { checks, store, notifier, config, log } = this.deps;
    this.lastCycleStartedAt = this.now().toISOString();
    const policy = { unknownAlertThreshold: config.unknownAlertThreshold, reminderMinutes: config.alertReminderMinutes };

    try {
      await this.retryPending();

      const results = await Promise.all(
        checks.map((check) =>
          runCheck(check, { timeoutMs: config.fetchTimeoutMs, fetch: this.fetchFn, now: this.now }),
        ),
      );

      // State and the outbox row are written synchronously for every result before any send starts.
      const outbox: Outgoing[] = [];
      for (const [idx, result] of results.entries()) {
        const check = checks[idx]!;
        try {
          store.recordResult(result);
          const prev = store.getAlertState(check.id) ?? initialAlertState();
          const { events, next } = decideAlerts(check, prev, result, policy);
          store.saveAlertState(check.id, next);
          for (const e of events) {
            let id: number | undefined;
            try {
              id = store.logAlert(e);
            } catch (err) {
              log.error('failed to log alert', { checkId: check.id, dedupeKey: e.dedupeKey, error: errMsg(err) });
            }
            outbox.push({ id, event: e });
          }
        } catch (err) {
          log.error('failed to process check result', { checkId: check.id, error: errMsg(err) });
        }
      }
      await settleBounded(outbox, SEND_CONCURRENCY, (o) => this.deliver(o));

      this.maybePrune();
      return results;
    } finally {
      this.cycles += 1;
      this.lastCycleCompletedAt = this.now().toISOString();
    }
  }

  /** Re-sends unsent alerts from earlier cycles (within the attempt cap and age cutoff). */
  private async retryPending(): Promise<void> {
    const { store, log } = this.deps;
    let pending: PendingAlert[];
    try {
      pending = store.pendingAlerts({
        maxAttempts: RETRY_MAX_ATTEMPTS,
        minCreatedAt: new Date(this.now().getTime() - RETRY_MAX_AGE_MS),
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
    await settleBounded(
      pending.map((p) => ({ id: p.id, event: p.event })),
      SEND_CONCURRENCY,
      (o) => this.deliver(o),
    );
  }

  /** Sends one alert and records the outcome on its outbox row (when it has one). Never throws. */
  private async deliver({ id, event: e }: Outgoing): Promise<void> {
    const { store, notifier, log } = this.deps;
    let result: DeliveryResult;
    try {
      result = await notifier.notify(e);
    } catch (err) {
      log.error('notify failed', { checkId: e.checkId, dedupeKey: e.dedupeKey, error: errMsg(err) });
      result = { ok: false, error: errMsg(err) };
    }
    if (id === undefined) return;
    try {
      if (result.ok) store.markAlertSent(id, this.now());
      else store.markAlertFailed(id, result.error ?? 'delivery failed');
    } catch (err) {
      log.error('failed to record alert delivery', { id, checkId: e.checkId, dedupeKey: e.dedupeKey, error: errMsg(err) });
    }
  }

  private maybePrune(): void {
    const now = this.now();
    if (this.lastPruneAt !== null && now.getTime() - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now.getTime();
    try {
      const deleted = this.deps.store.prune(this.deps.config.historyRetentionDays, now);
      this.deps.log.info('pruned history', { deleted });
    } catch (err) {
      this.deps.log.error('prune failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async (): Promise<void> => {
      try {
        await this.runCycle();
      } catch (err) {
        this.deps.log.error('poll cycle failed', { error: err instanceof Error ? err.message : String(err) });
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

  liveness(): Liveness {
    return {
      startedAt: this.startedAt,
      lastCycleStartedAt: this.lastCycleStartedAt,
      lastCycleCompletedAt: this.lastCycleCompletedAt,
      cycles: this.cycles,
      running: this.current !== null,
      intervalSeconds: this.deps.config.pollIntervalSeconds,
    };
  }

  isHealthy(now: Date = this.now()): boolean {
    const { pollIntervalSeconds, fetchTimeoutMs } = this.deps.config;
    const windowMs = (2 * pollIntervalSeconds + fetchTimeoutMs / 1000 + 30) * 1000;
    const ref = this.lastCycleCompletedAt ?? this.startedAt;
    return now.getTime() - Date.parse(ref) <= windowMs;
  }
}
