import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.js';
import type { Logger } from '../log.js';
import type { FetchFn } from '../types.js';
import type { AlertEvent } from './decide.js';
import { buildEmail, buildSlackPayload } from './format.js';

export interface Notifier {
  notify(e: AlertEvent): Promise<void>;
}

type SendMail = (m: { from: string; to: string[]; subject: string; text: string }) => Promise<void>;

const SLACK_TIMEOUT_MS = 10_000;
const SMTP_TIMEOUT_MS = 10_000;
const SEND_MAIL_DEADLINE_MS = 15_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createNotifier(
  cfg: Pick<AppConfig, 'slackWebhookUrl' | 'smtp' | 'appUrl'>,
  deps: { fetch: FetchFn; log: Logger; sendMail?: SendMail },
): Notifier {
  const { log } = deps;
  const smtp = cfg.smtp;

  const sendMail: SendMail | undefined = smtp
    ? (deps.sendMail ??
      (async (m) => {
        const transport = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          connectionTimeout: SMTP_TIMEOUT_MS,
          greetingTimeout: SMTP_TIMEOUT_MS,
          socketTimeout: SMTP_TIMEOUT_MS,
          ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
        });
        await transport.sendMail(m);
      }))
    : undefined;

  async function slack(e: AlertEvent): Promise<void> {
    try {
      const payload = buildSlackPayload(e, cfg.appUrl);
      if (!cfg.slackWebhookUrl) {
        log.info('slack webhook not configured; alert payload', { payload });
        return;
      }
      const res = await deps.fetch(cfg.slackWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'inspra-vendor-status-monitor/1.0' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        log.error('slack alert failed', { checkId: e.checkId, dedupeKey: e.dedupeKey, status: res.status });
      }
    } catch (err) {
      log.error('slack alert failed', { checkId: e.checkId, dedupeKey: e.dedupeKey, error: errMsg(err) });
    }
  }

  async function email(e: AlertEvent): Promise<void> {
    if (!smtp || !sendMail) return;
    try {
      const { subject, text } = buildEmail(e, cfg.appUrl);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sendMail timed out after ${SEND_MAIL_DEADLINE_MS} ms`)), SEND_MAIL_DEADLINE_MS);
      });
      try {
        await Promise.race([sendMail({ from: smtp.from, to: smtp.to, subject, text }), deadline]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      log.error('email alert failed', { checkId: e.checkId, dedupeKey: e.dedupeKey, error: errMsg(err) });
    }
  }

  return {
    async notify(e) {
      await Promise.allSettled([slack(e), email(e)]);
    },
  };
}
