export interface AppConfig {
  port: number;
  host: string;
  appUrl: string;
  basePath: string;
  pollIntervalSeconds: number;
  fetchTimeoutMs: number;
  alertReminderMinutes: number;
  unknownAlertThreshold: number;
  historyRetentionDays: number;
  dataDir: string;
  /** libSQL URL: `file:<path>` locally (default `file:<DATA_DIR>/status.db`) or Turso's `libsql://…`. */
  databaseUrl: string;
  databaseAuthToken?: string;
  /** Bearer token required by /api/poll. Unset = the endpoint is disabled. */
  cronSecret?: string;
  vendorsFile: string;
  slackWebhookUrl?: string;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
    to: string[];
  };
}

type Env = Record<string, string | undefined>;

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Alert links are built from APP_URL, so its path should end with BASE_PATH.
 * Returns a warning message when it does not; an empty BASE_PATH is always fine.
 */
export function appUrlWarning(cfg: Pick<AppConfig, 'appUrl' | 'basePath'>): string | undefined {
  if (cfg.basePath === '') return undefined;
  const path = new URL(cfg.appUrl).pathname.replace(/\/+$/, '');
  if (path.endsWith(cfg.basePath)) return undefined;
  return `APP_URL path "${path || '/'}" does not end with BASE_PATH "${cfg.basePath}"; alert links may not reach the dashboard`;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const errors: string[] = [];

  const str = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };

  const int = (name: string, def: number, min: number, max: number): number => {
    const raw = str(name);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
      return def;
    }
    return n;
  };

  const bool = (name: string, def: boolean): boolean => {
    const raw = str(name)?.toLowerCase();
    if (raw === undefined) return def;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    errors.push(`${name} must be true or false (got "${raw}")`);
    return def;
  };

  const url = (name: string): string | undefined => {
    const raw = str(name);
    if (raw === undefined) return undefined;
    if (!isHttpUrl(raw)) {
      errors.push(`${name} must be an http(s) URL`);
      return undefined;
    }
    return raw;
  };

  // Empty (the default) serves at the root; the Docker image sets /insprastatus.
  const rawBase = env['BASE_PATH']?.trim();
  let basePath = '';
  if (rawBase !== undefined) {
    const segments = rawBase.split('/').filter(Boolean);
    if (segments.every((seg) => /^[A-Za-z0-9._~-]+$/.test(seg))) {
      basePath = segments.length === 0 ? '' : '/' + segments.join('/');
    } else {
      errors.push(`BASE_PATH segments may only contain letters, digits, ".", "_", "~" and "-" (got "${rawBase}")`);
    }
  }

  const port = int('PORT', 8080, 1, 65535);
  // On Vercel, fall back to the production domain Vercel provides; elsewhere to the local server.
  const vercelHost = str('VERCEL_PROJECT_PRODUCTION_URL');
  const appUrl = (
    url('APP_URL') ?? (vercelHost ? `https://${vercelHost}${basePath}` : `http://localhost:${port}${basePath}`)
  ).replace(/\/+$/, '');

  const dataDir = str('DATA_DIR') ?? './data';
  const databaseUrl = str('DATABASE_URL') ?? `file:${dataDir.replaceAll('\\', '/').replace(/\/+$/, '')}/status.db`;
  if (!/^(file:|libsql:|https?:|wss?:|:memory:$)/.test(databaseUrl)) {
    errors.push('DATABASE_URL must start with file:, libsql:, https:, http:, wss: or ws:');
  }

  const config: AppConfig = {
    port,
    host: str('HOST') ?? '0.0.0.0',
    appUrl,
    basePath,
    pollIntervalSeconds: int('POLL_INTERVAL_SECONDS', 180, 60, 600),
    fetchTimeoutMs: int('FETCH_TIMEOUT_MS', 10000, 1000, 60000),
    alertReminderMinutes: int('ALERT_REMINDER_MINUTES', 60, 5, 1440),
    unknownAlertThreshold: int('UNKNOWN_ALERT_THRESHOLD', 3, 1, 20),
    historyRetentionDays: int('HISTORY_RETENTION_DAYS', 30, 1, 365),
    dataDir,
    databaseUrl,
    vendorsFile: str('VENDORS_FILE') ?? './vendors.yaml',
  };

  const databaseAuthToken = str('DATABASE_AUTH_TOKEN');
  if (databaseAuthToken) config.databaseAuthToken = databaseAuthToken;
  const cronSecret = str('CRON_SECRET');
  if (cronSecret) {
    if (cronSecret.length < 16) errors.push('CRON_SECRET must be at least 16 characters');
    config.cronSecret = cronSecret;
  }

  const slackWebhookUrl = url('SLACK_WEBHOOK_URL');
  if (slackWebhookUrl) config.slackWebhookUrl = slackWebhookUrl;

  const smtpHost = str('SMTP_HOST');
  if (smtpHost) {
    const from = str('SMTP_FROM');
    const toRaw = str('SMTP_TO');
    if (!from) errors.push('SMTP_FROM is required when SMTP_HOST is set');
    const to = (toRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (to.length === 0) errors.push('SMTP_TO is required when SMTP_HOST is set');
    config.smtp = {
      host: smtpHost,
      port: int('SMTP_PORT', 587, 1, 65535),
      secure: bool('SMTP_SECURE', false),
      user: str('SMTP_USER'),
      pass: str('SMTP_PASS'),
      from: from ?? '',
      to,
    };
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }
  return config;
}
