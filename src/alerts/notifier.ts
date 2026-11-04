import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.js';
import type { Logger } from '../log.js';
import type { FetchFn } from '../types.js';
import type { AlertEvent } from './decide.js';
import { buildEmail, buildSlackPayload } from './format.js';

/** `ok` is true only if every configured channel succeeded; log-only mode counts as delivered. */
export interface DeliveryResult {
  ok: boolean;
  error?: string;
}

export interface Notifier {
  notify(e: AlertEvent): Promise<DeliveryResult>;
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

  /** Resolves to an error message on failure, undefined on success (or when only logging). */
  async function slack(e: AlertEvent): Promise<string | undefined> {
    try {
      const payload = buildSlackPayload(e, cfg.appUrl);
      if (!cfg.slackWebhookUrl) {
        log.info('slack webhook not configured; alert payload', { payload });
        return undefined;
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
        return `slack: HTTP ${res.status}`;
      }
      return undefined;
    } catch (err) {
      log.error('slack alert failed', { checkId: e.checkId, dedupeKey: e.dedupeKey, error: errMsg(err) });
      return `slack: ${errMsg(err)}`;
    }
  }

  /** Resolves to an error message on failure, undefined on success or when SMTP is not configured. */
  async function email(e: AlertEvent): Promise<string | undefined> {
    if (!smtp || !sendMail) return undefined;
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
      return undefined;
    } catch (err) {
      log.error('email alert failed', { checkId: e.checkId, dedupeKey: e.dedupeKey, error: errMsg(err) });
      return `email: ${errMsg(err)}`;
    }
  }

  return {
    async notify(e) {
      const errors = (await Promise.all([slack(e), email(e)])).filter((x): x is string => x !== undefined);
      return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join('; ') };
    },
  };
}
