import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { isLocalDbUrl, Store } from '../src/store.js';

// The native driver must never load for a remote URL: on Vercel its platform binary is not in the
// function bundle, so importing it would crash. Make any use of it fail loudly.
vi.mock('@libsql/client', () => ({
  createClient: () => {
    throw new Error('native libsql client loaded');
  },
}));

describe('Store driver selection', () => {
  it('classifies local and remote URLs', () => {
    expect(isLocalDbUrl(':memory:')).toBe(true);
    expect(isLocalDbUrl('file:./data/status.db')).toBe(true);
    expect(isLocalDbUrl('file:///tmp/status.db')).toBe(true);
    expect(isLocalDbUrl('libsql://vsm-org.turso.io')).toBe(false);
    expect(isLocalDbUrl('https://vsm-org.turso.io')).toBe(false);
    expect(isLocalDbUrl('wss://vsm-org.turso.io')).toBe(false);
  });

  it('opens local databases with the native client', async () => {
    await expect(Store.open({ url: ':memory:' })).rejects.toThrow('native libsql client loaded');
  });

  it('opens a remote database with the web client, sending the auth token', async () => {
    const seen: { url?: string; auth?: string } = {};
    const server = createServer((req, res) => {
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      res.writeHead(500).end('test server');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const err = await Store.open({ url: `http://127.0.0.1:${port}`, authToken: 'tok-123' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/native libsql client loaded/);
      expect(seen.url).toMatch(/^\/v\d\/pipeline$/);
      expect(seen.auth).toBe('Bearer tok-123');
    } finally {
      server.close();
    }
  });

  it('aborts a remote request that outlives requestTimeoutMs', async () => {
    const server = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const started = Date.now();
      const err = await Store.open({ url: `http://127.0.0.1:${port}`, requestTimeoutMs: 200 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
