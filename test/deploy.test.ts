import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const dockerfileProbe = (): string => {
  const m = /^HEALTHCHECK .* CMD node -e "(.*)"$/m.exec(read('Dockerfile'));
  if (!m) throw new Error('HEALTHCHECK node -e expression not found');
  return m[1]!;
};

interface ComposeService {
  environment: string[];
  stop_grace_period?: string;
  healthcheck: { test: string[] };
}
const composeService = (): ComposeService =>
  (parse(read('docker-compose.yml')) as { services: Record<string, ComposeService> }).services[
    'vendor-status-monitor'
  ]!;
// Compose turns `$$` into a literal `$` before the container sees it.
const composeProbe = (): string => composeService().healthcheck.test.at(-1)!.replace(/\$\$/g, '$');

/** Evaluates a probe expression with a stub fetch; returns the path it requested, minus /healthz. */
function probedPath(expr: string, basePath: string | undefined): string {
  const urls: string[] = [];
  const env: Record<string, string> = { PORT: '8080' };
  if (basePath !== undefined) env['BASE_PATH'] = basePath;
  runInNewContext(expr, {
    process: { env, exit: () => undefined },
    fetch: (u: string) => {
      urls.push(u);
      return new Promise(() => undefined);
    },
  });
  expect(urls).toHaveLength(1);
  const url = new URL(urls[0]!);
  expect(url.origin).toBe('http://127.0.0.1:8080');
  expect(url.pathname.endsWith('/healthz')).toBe(true);
  return url.pathname.slice(0, -'/healthz'.length);
}

describe.each([
  ['Dockerfile', dockerfileProbe],
  ['docker-compose.yml', composeProbe],
])('%s healthcheck', (_name, probe) => {
  it.each([
    ['insprastatus', '/insprastatus'],
    ['/insprastatus/', '/insprastatus'],
    ['', ''],
    [undefined, '/insprastatus'],
  ])('normalises BASE_PATH %j to %j', (basePath, expected) => {
    expect(probedPath(probe(), basePath)).toBe(expected);
  });
});

describe('docker-compose.yml', () => {
  it('pins HOST to 0.0.0.0 and allows 30s for a graceful stop', () => {
    const svc = composeService();
    expect(svc.environment).toContain('HOST=0.0.0.0');
    expect(svc.stop_grace_period).toBe('30s');
  });
});
