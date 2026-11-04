import { ParseError, type CheckContext } from './types.js';

export const USER_AGENT = 'inspra-vendor-status-monitor/1.0';
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

async function readCapped(res: Response, url: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new FetchError(`response from ${url} exceeds 5 MB`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FetchError(`response from ${url} exceeds 5 MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchText(
  ctx: CheckContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await ctx.fetch(url, {
      headers: { 'user-agent': USER_AGENT, ...headers },
      signal: ctx.signal,
      redirect: 'follow',
    });
    const body = await readCapped(res, url);
    return { statusCode: res.status, body, latencyMs: Date.now() - start };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new FetchError(`request to ${url} failed: ${msg}`);
  }
}

export async function fetchJson(
  ctx: CheckContext,
  url: string,
  opts: { headers?: Record<string, string>; optional?: boolean } = {},
): Promise<unknown | null> {
  const res = await fetchText(ctx, url, opts.headers);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    if (opts.optional && res.statusCode === 404) return null;
    throw new FetchError(`HTTP ${res.statusCode} from ${url}`);
  }
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new ParseError(`invalid JSON from ${url}`);
  }
}
