import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.USST_LOG_LEVEL ?? 'info'] ?? LEVELS.info;

const MAX_MEMORY = 400;
/** @type {Array<object>} */
const memory = [];

const REDACT_KEYS = /^(password|passwd|pwd|captcha|ticket|token|cookie|authorization)$/i;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.test(k) ? '***' : redact(v, depth + 1);
  }
  return out;
}

function ensureDir() {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
}

function emit(level, scope, message, extra) {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(extra === undefined ? {} : { extra: redact(extra) }),
  };
  memory.push(record);
  if (memory.length > MAX_MEMORY) memory.shift();

  const line = `[${record.ts}] ${level.toUpperCase().padEnd(5)} ${scope} — ${message}`;

  if (level === 'error') console.error(line, extra === undefined ? '' : extra);
  else if (level === 'warn') console.warn(line, extra === undefined ? '' : extra);
  else console.log(line, extra === undefined ? '' : extra);

  try {
    ensureDir();
    appendFileSync(join(config.dataDir, 'app.log'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    /* 日志落盘失败不影响主流程 */
  }
}

export const log = {
  debug: (scope, message, extra) => emit('debug', scope, message, extra),
  info: (scope, message, extra) => emit('info', scope, message, extra),
  warn: (scope, message, extra) => emit('warn', scope, message, extra),
  error: (scope, message, extra) => emit('error', scope, message, extra),
};

export function recentLogs(limit = 200) {
  return memory.slice(Math.max(0, memory.length - limit));
}

export function readLogFile(limit = 300) {
  try {
    const text = readFileSync(join(config.dataDir, 'app.log'), 'utf8');
    const lines = text.trim().split('\n').slice(-limit);
    return lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { ts: '', level: 'info', scope: 'log', message: l };
      }
    });
  } catch {
    return [];
  }
}

export function clearLogFile() {
  try {
    ensureDir();
    writeFileSync(join(config.dataDir, 'app.log'), '', 'utf8');
  } catch {
    /* ignore */
  }
}
