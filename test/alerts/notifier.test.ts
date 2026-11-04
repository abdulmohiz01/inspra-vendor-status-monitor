import { describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../../src/alerts/decide.js';
import { buildSlackPayload } from '../../src/alerts/format.js';
import { createNotifier } from '../../src/alerts/notifier.js';

const APP = 'https://hub.automateaccelerator.com/insprastatus';
const event: AlertEvent = {
  kind: 'degraded',
  checkId: 'northflank',
  checkName: 'Northflank',
  from: 'operational',
  to: 'major_outage',
  since: '2026-11-04T10:00:00.000Z',
  at: '2026-11-04T10:00:00.000Z',
  incidents: [],
  components: [],
  dedupeKey: 'northflank:state:major_outage',
};
const smtp = { host: 'smtp.test', port: 587, secure: false, from: 'a@x.test', to: ['b@x.test', 'c@x.test'] };

function silent() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('createNotifier', () => {
  it('logs the payload and does not fetch when no webhook is configured', async () => {
    const fetch = vi.fn();
    const log = silent();
    await createNotifier({ appUrl: APP }, { fetch: fetch as never, log }).notify(event);
    expect(fetch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'slack webhook not configured; alert payload',
      expect.objectContaining({ payload: buildSlackPayload(event, APP) }),
    );
  });

  it('POSTs the Slack payload as JSON', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const url = 'https://hooks.slack.test/T/B/x';
    await createNotifier({ appUrl: APP, slackWebhookUrl: url }, { fetch: fetch as never, log: silent() }).notify(event);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetch.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(buildSlackPayload(event, APP));
  });

  it('logs and resolves when fetch rejects or returns non-2xx', async () => {
    const log = silent();
    const url = 'https://hooks.slack.test/x';
    await createNotifier(
      { appUrl: APP, slackWebhookUrl: url },
      { fetch: vi.fn().mockRejectedValue(new Error('down')) as never, log },
    ).notify(event);
    expect(log.error).toHaveBeenCalledTimes(1);
    await createNotifier(
      { appUrl: APP, slackWebhookUrl: url },
      { fetch: vi.fn().mockResolvedValue(new Response('no', { status: 500 })) as never, log },
    ).notify(event);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('sends email only when smtp is configured, and survives failures', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn();
    await createNotifier({ appUrl: APP, smtp }, { fetch: fetch as never, log: silent(), sendMail }).notify(event);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ from: 'a@x.test', to: ['b@x.test', 'c@x.test'] });

    const none = vi.fn();
    await createNotifier({ appUrl: APP }, { fetch: fetch as never, log: silent(), sendMail: none }).notify(event);
    expect(none).not.toHaveBeenCalled();

    const log = silent();
    await createNotifier(
      { appUrl: APP, smtp },
      { fetch: fetch as never, log, sendMail: vi.fn().mockRejectedValue(new Error('smtp down')) },
    ).notify(event);
    expect(log.error).toHaveBeenCalled();
  });

  it('does not let a hung sendMail hold the caller beyond the deadline', async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      const log = silent();
      const p = createNotifier(
        { appUrl: APP, smtp },
        { fetch: vi.fn() as never, log, sendMail: () => new Promise<void>(() => undefined) },
      )
        .notify(event)
        .then(done);
      await vi.advanceTimersByTimeAsync(15_001);
      await p;
      expect(done).toHaveBeenCalled();
      expect(log.error).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
