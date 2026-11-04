import type { CheckOutcome, Incident, Status } from '../types.js';
import { summarise } from '../normalise.js';

function finish(status: Status, incident?: Incident, error?: string): CheckOutcome {
  const outcome: CheckOutcome = {
    status,
    components: [],
    incidents: incident ? [incident] : [],
    ...(error ? { error } : {}),
  };
  return { ...outcome, summary: summarise(outcome) };
}

export function parseHttp(
  res: { statusCode: number; body: string; latencyMs: number },
  opts: { url: string; expectBody?: string; slowMs: number },
): CheckOutcome {
  const { statusCode } = res;

  if (statusCode === 429) return finish('unknown', undefined, `HTTP 429 (rate limited) from ${opts.url}`);
  if (statusCode >= 500) {
    return finish('major_outage', { id: `http-${statusCode}`, title: `HTTP ${statusCode} from ${opts.url}`, status: 'major_outage' });
  }
  if (statusCode >= 400) {
    return finish('degraded', { id: `http-${statusCode}`, title: `HTTP ${statusCode} from ${opts.url}`, status: 'degraded' });
  }
  if (statusCode < 200 || statusCode >= 400) {
    return finish('unknown', undefined, `Unexpected HTTP ${statusCode} from ${opts.url}`);
  }

  if (opts.expectBody !== undefined && !res.body.includes(opts.expectBody)) {
    return finish('degraded', {
      id: 'http-body',
      title: `Health response did not contain "${opts.expectBody}"`,
      status: 'degraded',
    });
  }
  if (res.latencyMs > opts.slowMs) {
    return finish('degraded', {
      id: 'http-slow',
      title: `Slow response: ${res.latencyMs} ms (limit ${opts.slowMs} ms)`,
      status: 'degraded',
    });
  }
  return finish('operational');
}
