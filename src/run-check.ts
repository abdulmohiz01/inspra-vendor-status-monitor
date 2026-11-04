import type { Check, CheckResult, FetchFn } from './types.js';

export async function runCheck(
  check: Check,
  opts: { timeoutMs: number; fetch: FetchFn; now?: () => Date },
): Promise<CheckResult> {
  const clock = opts.now ?? (() => new Date());
  const started = clock();
  const t0 = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${opts.timeoutMs} ms`);
      controller.abort(err);
      reject(err);
    }, opts.timeoutMs);
  });

  const meta = () => ({ checkId: check.id, checkedAt: started.toISOString(), durationMs: Date.now() - t0 });

  try {
    const run = Promise.resolve().then(() =>
      check.run({ fetch: opts.fetch, signal: controller.signal, now: started, timeoutMs: opts.timeoutMs }),
    );
    run.catch(() => undefined); // a late rejection after the timeout must not go unhandled
    const outcome = await Promise.race([run, timeout]);
    return { ...outcome, ...meta() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: 'unknown',
      components: [],
      incidents: [],
      error: message,
      summary: `Check failed: ${message}`,
      ...meta(),
    };
  } finally {
    clearTimeout(timer);
  }
}
