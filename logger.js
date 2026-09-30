'use strict';
/**
 * Minimal logger. Logs job ids + statuses only — never tokens, cookies,
 * credentials or message content. Anything that looks like a secret is redacted.
 */
const SECRET_KEYS = /token|secret|password|cookie|authorization|apikey|api_key|message|comment|note|text|body|html/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 3) return '[…]';
  if (typeof value === 'string') {
    if (/^ey[A-Za-z0-9_-]{10,}\./.test(value)) return '[redacted-jwt]';
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    if (value instanceof Error) return value.message;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function fmt(level, scope, msg, meta) {
  const ts = new Date().toISOString();
  const m = meta === undefined ? '' : ` ${JSON.stringify(redact(meta))}`;
  return `${ts} ${level.toUpperCase()} [${scope}] ${msg}${m}`;
}

function createLogger(scope = 'app') {
  const quiet = process.env.KONEQTI_QUIET === '1';
  return {
    info: (msg, meta) => { if (!quiet) console.log(fmt('info', scope, msg, meta)); },
    warn: (msg, meta) => { if (!quiet) console.warn(fmt('warn', scope, msg, meta)); },
    error: (msg, meta) => { console.error(fmt('error', scope, msg, meta)); },
    debug: (msg, meta) => { if (process.env.KONEQTI_DEBUG === '1') console.log(fmt('debug', scope, msg, meta)); },
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

module.exports = { createLogger, redact };
