import { LoggerService } from '@nestjs/common';
import { CORRELATION_KEYS, currentCorrelation } from './correlation';
import { emitLogLine } from './log-sink';

/**
 * One JSON object per line on stdout. Every line automatically carries the
 * ambient correlation fields (`correlationId`, `messageId`, `transactionId`,
 * `walletId`, `providerId`) from the current async scope.
 *
 * Call sites pass either a plain string or an object `{ msg, ...structuredMeta }`
 * — never string-interpolated money or a raw transaction payload.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  private write(level: string, message: unknown, rest: unknown[]): void {
    const { msg, meta } = normalize(message);
    const corr = currentCorrelation();

    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      logger: lastString(rest) ?? 'app',
      msg,
    };
    for (const key of CORRELATION_KEYS) {
      const value = corr[key];
      if (value !== undefined && value !== null) record[key] = value;
    }
    for (const [k, v] of Object.entries(meta)) {
      if (!(k in record)) record[k] = v;
    }

    emitLogLine(safeStringify(record) + '\n');
  }
}

function normalize(message: unknown): { msg: string; meta: Record<string, unknown> } {
  if (typeof message === 'string') return { msg: message, meta: {} };
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const obj = message as Record<string, unknown>;
    const meta: Record<string, unknown> = {};
    let msg = '';
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'msg' || k === 'message') msg = String(v);
      else meta[k] = v;
    }
    return { msg, meta };
  }
  return { msg: String(message), meta: {} };
}

function lastString(rest: unknown[]): string | undefined {
  for (let i = rest.length - 1; i >= 0; i--) {
    const v = rest[i];
    if (typeof v === 'string' && !v.includes('\n')) return v;
  }
  return undefined;
}

function safeStringify(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ ts: record.ts, level: record.level, msg: String(record.msg) });
  }
}
