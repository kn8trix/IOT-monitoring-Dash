'use strict';

/**
 * Small, dependency-free middleware: fixed-window rate limiting plus a
 * request logger that feeds the dashboard terminal.
 */

const config = require('./config');
const { log } = require('./events');

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fixed-window in-memory limiter. Good enough for a single-container LAN
 * deployment; swap for Redis if you scale the server horizontally.
 * @param {{ windowSeconds?: number, max?: number, keyFn?: (req) => string }} [opts]
 */
function rateLimit(opts = {}) {
  const windowMs = (opts.windowSeconds ?? config.rateLimit.windowSeconds) * 1000;
  const max = opts.max ?? config.rateLimit.max;
  const keyFn = opts.keyFn || ((req) => req.ip || req.socket?.remoteAddress || 'unknown');
  const hits = new Map();

  // Periodic cleanup so the map can't grow unbounded.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (now - entry.startedAt > windowMs * 2) hits.delete(key);
  }, Math.max(windowMs, 10_000));
  timer.unref?.();

  return function rateLimiter(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || now - entry.startedAt >= windowMs) {
      entry = { startedAt: now, count: 0 };
      hits.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(max - entry.count, 0);
    const resetSeconds = Math.ceil((entry.startedAt + windowMs - now) / 1000);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (entry.count > max) {
      res.setHeader('Retry-After', resetSeconds);
      return res.status(429).json({
        ok: false,
        error: 'rate limit exceeded',
        retry_after_seconds: resetSeconds,
      });
    }
    return next();
  };
}

/* -------------------------------------------------------------------------- */
/* Request logging -> terminal                                                */
/* -------------------------------------------------------------------------- */

const SILENT_PATHS = [/^\/api\/stats$/, /^\/api\/health$/, /^\/api\/devices$/, /^\/socket\.io/];

function requestLogger(req, res, next) {
  const startedAt = Date.now();

  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    // Static dashboard assets never reach the terminal.
    if (!path.startsWith('/api')) return;
    if (SILENT_PATHS.some((re) => re.test(path))) return;

    // High-volume ingest is logged (throttled) by the ingest pipeline instead.
    const isIngest = path === '/api/webhook/data' && req.method === 'POST';
    if (isIngest && res.statusCode < 400) return;

    const ms = Date.now() - startedAt;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log(level, 'HTTP', `${req.method} ${path} → ${res.statusCode} (${ms}ms)`);
  });

  next();
}

module.exports = { rateLimit, requestLogger };
