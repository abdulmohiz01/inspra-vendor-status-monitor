import { describe, expect, it } from 'vitest';
import { appUrlWarning, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('returns defaults for an empty env', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      appUrl: 'http://localhost:8080',
      basePath: '',
      pollIntervalSeconds: 180,
      fetchTimeoutMs: 10000,
      alertReminderMinutes: 60,
      unknownAlertThreshold: 3,
      historyRetentionDays: 30,
      dataDir: './data',
      databaseUrl: 'file:./data/status.db',
      vendorsFile: './vendors.yaml',
    });
    expect(c.databaseAuthToken).toBeUndefined();
    expect(c.cronSecret).toBeUndefined();
    expect(c.smtp).toBeUndefined();
    expect(c.slackWebhookUrl).toBeUndefined();
  });

  it('defaults APP_URL to the local server, or the Vercel production domain, including BASE_PATH', () => {
    expect(loadConfig({ PORT: '4180', BASE_PATH: '/insprastatus' }).appUrl).toBe('http://localhost:4180/insprastatus');
    expect(loadConfig({ VERCEL_PROJECT_PRODUCTION_URL: 'vsm.vercel.app' }).appUrl).toBe('https://vsm.vercel.app');
    expect(
      loadConfig({ VERCEL_PROJECT_PRODUCTION_URL: 'vsm.vercel.app', APP_URL: 'https://status.example.com' }).appUrl,
    ).toBe('https://status.example.com');
  });

  it('derives DATABASE_URL from DATA_DIR, or takes it with its auth token as given', () => {
    expect(loadConfig({ DATA_DIR: '/data/' }).databaseUrl).toBe('file:/data/status.db');
    expect(loadConfig({ DATA_DIR: 'C:\\vsm\\data' }).databaseUrl).toBe('file:C:/vsm/data/status.db');
    const c = loadConfig({ DATABASE_URL: 'libsql://vsm-org.turso.io', DATABASE_AUTH_TOKEN: 'tok' });
    expect(c.databaseUrl).toBe('libsql://vsm-org.turso.io');
    expect(c.databaseAuthToken).toBe('tok');
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/DATABASE_URL/);
  });

  it('requires CRON_SECRET to be at least 16 characters', () => {
    expect(loadConfig({ CRON_SECRET: 'a'.repeat(16) }).cronSecret).toBe('a'.repeat(16));
    expect(() => loadConfig({ CRON_SECRET: 'short' })).toThrow(/CRON_SECRET/);
  });

  it('strips trailing slashes from APP_URL', () => {
    expect(loadConfig({ APP_URL: 'http://localhost:4180/' }).appUrl).toBe('http://localhost:4180');
  });

  it('normalises BASE_PATH', () => {
    expect(loadConfig({ BASE_PATH: '' }).basePath).toBe('');
    expect(loadConfig({ BASE_PATH: '/' }).basePath).toBe('');
    expect(loadConfig({ BASE_PATH: 'foo/' }).basePath).toBe('/foo');
    expect(() => loadConfig({ BASE_PATH: '/a b' })).toThrow(/BASE_PATH/);
  });

  it('strips trailing slash from a path-bearing APP_URL', () => {
    expect(loadConfig({ APP_URL: 'http://localhost:4180/insprastatus/' }).appUrl).toBe(
      'http://localhost:4180/insprastatus',
    );
  });

  it('rejects out-of-range values and names the variable', () => {
    expect(() => loadConfig({ POLL_INTERVAL_SECONDS: '30' })).toThrow(/POLL_INTERVAL_SECONDS/);
    expect(() => loadConfig({ POLL_INTERVAL_SECONDS: '601' })).toThrow(/POLL_INTERVAL_SECONDS/);
  });

  it('lists every invalid variable', () => {
    expect(() => loadConfig({ POLL_INTERVAL_SECONDS: '1', FETCH_TIMEOUT_MS: '5' })).toThrow(
      /POLL_INTERVAL_SECONDS[\s\S]*FETCH_TIMEOUT_MS/,
    );
  });

  it('treats empty strings as unset', () => {
    const c = loadConfig({ SLACK_WEBHOOK_URL: '', PORT: '' });
    expect(c.slackWebhookUrl).toBeUndefined();
    expect(c.port).toBe(8080);
  });

  it('rejects an invalid Slack webhook URL', () => {
    expect(() => loadConfig({ SLACK_WEBHOOK_URL: 'not a url' })).toThrow(/SLACK_WEBHOOK_URL/);
  });

  it('requires SMTP_FROM and SMTP_TO when SMTP_HOST is set', () => {
    expect(() => loadConfig({ SMTP_HOST: 'smtp.x' })).toThrow(/SMTP_FROM/);
  });

  it('parses a full SMTP config', () => {
    const c = loadConfig({
      SMTP_HOST: 'smtp.x',
      SMTP_FROM: 'status@x.com',
      SMTP_TO: 'a@x.com, b@x.com',
    });
    expect(c.smtp).toEqual({
      host: 'smtp.x',
      port: 587,
      secure: false,
      user: undefined,
      pass: undefined,
      from: 'status@x.com',
      to: ['a@x.com', 'b@x.com'],
    });
  });
});

describe('appUrlWarning', () => {
  const w = (appUrl: string, basePath: string) => appUrlWarning({ appUrl, basePath });

  it('is silent when the APP_URL path ends with BASE_PATH', () => {
    expect(appUrlWarning(loadConfig({}))).toBeUndefined();
    expect(w('https://hub.example.com/insprastatus/', '/insprastatus')).toBeUndefined();
    expect(w('https://hub.example.com/tools/insprastatus', '/insprastatus')).toBeUndefined();
    expect(w('https://hub.example.com/a/b', '/a/b')).toBeUndefined();
  });

  it('is always silent for an empty BASE_PATH', () => {
    expect(w('https://status.example.com', '')).toBeUndefined();
    expect(w('https://status.example.com/anything', '')).toBeUndefined();
  });

  it('warns when the APP_URL path does not end with BASE_PATH', () => {
    expect(w('http://localhost:4180', '/insprastatus')).toMatch(/APP_URL.*BASE_PATH/);
    expect(w('https://hub.example.com/otherinsprastatus', '/insprastatus')).toBeDefined();
    expect(w('https://hub.example.com/insprastatus/extra', '/insprastatus')).toBeDefined();
  });
});
