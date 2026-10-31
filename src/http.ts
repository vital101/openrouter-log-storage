/**
 * Minimal fetch-based HTTP primitives replacing Express.
 *
 * A `Handler` takes a `Request` and returns a `Response`; a `Middleware` wraps
 * a handler. Composition is explicit so the request path has no hidden global
 * state and each behavior (security headers, logging, errors, rate limiting)
 * is independently testable.
 */

import type { Logger } from "./logger.js";

export type Handler = (req: Request, socketIp?: string | null) => Promise<Response> | Response;
export type Middleware = (next: Handler) => Handler;

/** An error that maps to a specific status + JSON body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

/** Compose middleware left-to-right: the first argument is outermost. */
export function compose(
  ...middlewares: Middleware[]
): (base: Handler) => Handler {
  return (base) => middlewares.reduceRight<Handler>((next, mw) => mw(next), base);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers: h });
}

export function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export interface Route {
  method: string;
  path: string;
  handler: Handler;
}

/**
 * Method + path matcher. Unknown path or method returns 404 (Express's default
 * for a missing route). Query strings are ignored for matching.
 */
export function router(routes: Route[]): Handler {
  return async (req, socketIp) => {
    const { pathname } = new URL(req.url);
    for (const route of routes) {
      if (route.method === req.method && route.path === pathname) {
        return route.handler(req, socketIp);
      }
    }
    return text("Not Found", 404);
  };
}

/**
 * Parse a byte-size string like "10mb", "512kb", "1gb", "10b".
 * Mirrors the `bytes` package used by express.json's `limit` option.
 */
export function parseByteSize(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(value);
  if (!match) throw new HttpError(500, "invalid_body_limit");
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };
  return Math.floor(amount * (multipliers[unit] ?? 1));
}

function isJsonContentType(req: Request): boolean {
  const raw = req.headers.get("content-type");
  if (!raw) return false;
  const type = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || /^application\/[^/]+\+json$/.test(type);
}

/**
 * Read and parse a JSON request body, matching express.json's observable
 * behavior:
 * - non-JSON content types are not parsed (returns `undefined`, as Express 5
 *   leaves `req.body` undefined when no parser matches)
 * - empty body parses to `{}`
 * - malformed JSON and non-object/array top-level values (strict mode) raise
 *   400 `invalid_json`
 * - bodies over `limitBytes` raise 413 `payload_too_large`
 */
export async function readJsonBody(req: Request, limitBytes: number): Promise<unknown> {
  if (!isJsonContentType(req)) return undefined;

  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > limitBytes) {
    throw new HttpError(413, "payload_too_large");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  }

  if (total === 0) return {};

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json");
  }

  // express.json's strict mode only accepts objects and arrays.
  if (parsed === null || typeof parsed !== "object") {
    throw new HttpError(400, "invalid_json");
  }
  return parsed;
}

/**
 * Client IP for rate limiting. With `trust proxy 1` Express reports the last
 * (right-most) X-Forwarded-For entry; otherwise the socket address.
 */
export function resolveClientIp(req: Request, socketIp?: string | null): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return socketIp ?? "unknown";
}

/** Helmet's default security headers, applied to every response. */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-XSS-Protection": "0",
};

export function securityHeaders(): Middleware {
  return (next) => async (req, socketIp) => {
    const res = await next(req, socketIp);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      // Route-specific headers (e.g. the usage page's narrower CSP) win.
      if (!res.headers.has(key)) res.headers.set(key, value);
    }
    return res;
  };
}

/** Narrow slice of Logger needed by request logging and error handling. */
export type RequestLogger = Pick<Logger, "info">;

/** Per-request completion log, shaped like pino-http's default output. */
export function requestLogger(logger: RequestLogger): Middleware {
  return (next) => async (req, socketIp) => {
    const start = performance.now();
    try {
      const res = await next(req, socketIp);
      logger.info(
        {
          req: { method: req.method, url: new URL(req.url).pathname },
          res: { statusCode: res.status },
          responseTime: Math.round(performance.now() - start),
        },
        "request completed",
      );
      return res;
    } catch (err) {
      logger.info(
        {
          req: { method: req.method, url: new URL(req.url).pathname },
          res: { statusCode: 500 },
          responseTime: Math.round(performance.now() - start),
        },
        "request failed",
      );
      throw err;
    }
  };
}

/** Map thrown errors to the same JSON bodies Express's errorHandler produced. */
export function errorHandler(logger: RequestLogger): Middleware {
  return (next) => async (req, socketIp) => {
    try {
      return await next(req, socketIp);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.code }, err.status);
      }
      logger.info({ err }, "unhandled request error");
      return json({ error: "internal_error" }, 500);
    }
  };
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Return true to skip counting this request (e.g. connectivity checks). */
  skip?: (req: Request) => boolean;
  clientIp?: (req: Request, socketIp?: string | null) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter with express-rate-limit's draft-6 headers and
 * 429 `{ error: "rate_limited" }` body.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const { windowMs, max, skip, clientIp = resolveClientIp } = options;
  const buckets = new Map<string, Bucket>();

  return (next) => async (req, socketIp) => {
    if (skip?.(req)) return next(req, socketIp);

    const now = Date.now();
    const key = clientIp(req, socketIp);
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    // Opportunistic cleanup so the map cannot grow without bound.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }

    const headers = {
      "RateLimit-Limit": String(max),
      "RateLimit-Remaining": String(Math.max(0, max - bucket.count)),
      "RateLimit-Reset": String(Math.max(0, Math.ceil((bucket.resetAt - now) / 1000))),
    };

    if (bucket.count > max) {
      return json({ error: "rate_limited" }, 429, headers);
    }

    const res = await next(req, socketIp);
    for (const [headerName, headerValue] of Object.entries(headers)) {
      res.headers.set(headerName, headerValue);
    }
    return res;
  };
}
