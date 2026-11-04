import { decideAlerts, initialAlertState } from './alerts/decide.js';
import type { Notifier } from './alerts/notifier.js';
import type { AppConfig } from './config.js';
import type { Logger } from './log.js';
import { runCheck } from './run-check.js';
import type { Store } from './store.js';
import type { Check, CheckResult, FetchFn } from './types.js';

const PRUNE_EVERY_MS = 60 * 60 * 1000;

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
      const results = await Promise.all(
        checks.map((check) =>
          runCheck(check, { timeoutMs: config.fetchTimeoutMs, fetch: this.fetchFn, now: this.now }),
        ),
      );

      for (const [idx, result] of results.entries()) {
        const check = checks[idx]!;
        try {
          store.recordResult(result);
          const prev = store.getAlertState(check.id) ?? initialAlertState();
          const { events, next } = decideAlerts(check, prev, result, policy);
          store.saveAlertState(check.id, next);
          await Promise.allSettled(
            events.map(async (e) => {
              try {
                store.logAlert(e);
              } catch (err) {
                log.error('failed to log alert', { checkId: check.id, dedupeKey: e.dedupeKey, error: String(err) });
              }
              try {
                await notifier.notify(e);
              } catch (err) {
                log.error('notify failed', { checkId: check.id, dedupeKey: e.dedupeKey, error: String(err) });
              }
            }),
          );
        } catch (err) {
          log.error('failed to process check result', {
            checkId: check.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      this.maybePrune();
      return results;
    } finally {
      this.cycles += 1;
      this.lastCycleCompletedAt = this.now().toISOString();
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
