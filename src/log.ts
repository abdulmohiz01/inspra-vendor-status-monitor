export type LogFn = (msg: string, fields?: object) => void;

export type Logger = { info: LogFn; warn: LogFn; error: LogFn };

type Level = 'info' | 'warn' | 'error';

function line(level: Level, msg: string, fields?: object): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n';
}

/** JSON-lines logger: info to stdout, warn/error to stderr. */
export function createLogger(): Logger {
  return {
    info: (msg, fields) => void process.stdout.write(line('info', msg, fields)),
    warn: (msg, fields) => void process.stderr.write(line('warn', msg, fields)),
    error: (msg, fields) => void process.stderr.write(line('error', msg, fields)),
  };
}
