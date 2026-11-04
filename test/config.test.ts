import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('returns defaults for an empty env', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      appUrl: 'https://status.automateaccelerator.com',
      pollIntervalSeconds: 180,
      fetchTimeoutMs: 10000,
      alertReminderMinutes: 60,
      unknownAlertThreshold: 3,
      historyRetentionDays: 30,
      dataDir: './data',
      vendorsFile: './vendors.yaml',
    });
    expect(c.smtp).toBeUndefined();
    expect(c.slackWebhookUrl).toBeUndefined();
  });

  it('strips trailing slashes from APP_URL', () => {
    expect(loadConfig({ APP_URL: 'http://localhost:4180/' }).appUrl).toBe('http://localhost:4180');
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
