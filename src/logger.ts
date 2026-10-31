/**
 * Minimal structured JSON logger.
 *
 * Emits one JSON object per line to stdout with the same shape pino produced
 * for this service (`{ level, time, service, ...fields, msg }`, with `err`
 * serialized as `{ type, message, stack }`), so existing log consumers keep
 * working without pino's dependency tree or async worker transport.
 */

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

const LEVEL_NUMBERS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

export interface Logger {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  cause?: unknown;
  errors?: unknown[];
}

/** pino.stdSerializers.err-compatible output. */
export function serializeError(err: Error, depth = 0): SerializedError {
  const out: SerializedError = {
    type: err.name || "Error",
    message: err.message,
    stack: err.stack,
  };
  if (depth >= 5) return out;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) {
    out.cause = cause instanceof Error ? serializeError(cause, depth + 1) : cause;
  }
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    out.errors = errors.map((e) => (e instanceof Error ? serializeError(e, depth + 1) : e));
  }
  return out;
}

function normalize(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((v) => normalize(v, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalize(v, seen);
    }
    return out;
  }
  return value;
}

function safeStringify(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    // Circular or otherwise unserializable payloads must never break logging.
    return JSON.stringify({
      level: record["level"],
      time: record["time"],
      service: record["service"],
      msg: record["msg"] ?? "unserializable log payload",
    });
  }
}

export function createLogger(level: string = "info"): Logger {
  const threshold = LEVEL_NUMBERS[level as LogLevel] ?? LEVEL_NUMBERS.info;

  const make = (bindings: Record<string, unknown>): Logger => {
    const write = (levelName: LogLevel, arg: unknown, msg?: string): void => {
      const levelNumber = LEVEL_NUMBERS[levelName];
      if (levelNumber < threshold) return;

      const message = msg ?? (typeof arg === "string" ? arg : "");
      let fields: Record<string, unknown> = {};

      if (msg !== undefined) {
        // Called as logger.info(obj, "msg")
        if (arg instanceof Error) fields = { err: serializeError(arg) };
        else if (arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
          fields = normalize(arg) as Record<string, unknown>;
        }
      } else if (arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
        // Called as logger.info(obj) with no message
        if (arg instanceof Error) fields = { err: serializeError(arg) };
        else fields = normalize(arg) as Record<string, unknown>;
      }

      const record: Record<string, unknown> = {
        level: levelNumber,
        time: Date.now(),
        ...bindings,
        ...fields,
        msg: message,
      };

      process.stdout.write(`${safeStringify(record)}\n`);
    };

    return {
      trace: (obj, msg) => write("trace", obj, msg),
      debug: (obj, msg) => write("debug", obj, msg),
      info: (obj, msg) => write("info", obj, msg),
      warn: (obj, msg) => write("warn", obj, msg),
      error: (obj, msg) => write("error", obj, msg),
      fatal: (obj, msg) => write("fatal", obj, msg),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  };

  return make({ service: "openrouter-log-storage" });
}
