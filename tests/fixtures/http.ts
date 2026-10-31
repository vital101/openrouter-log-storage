import type { Handler } from "../../src/http.js";

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Serialized as JSON with Content-Type: application/json (like supertest .send). */
  json?: unknown;
  /** Raw body; use for malformed JSON or size-limit tests. */
  body?: string;
  socketIp?: string | null;
}

/**
 * Invoke a fetch handler with a synthesized Request. No port is bound, so this
 * replaces supertest for reachability and is faster.
 */
export function call(
  handler: Handler,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const { method = "GET", headers = {}, json, body, socketIp = null } = options;

  const finalHeaders = new Headers(headers);
  let payload: string | undefined = body;

  if (json !== undefined) {
    payload = JSON.stringify(json);
    if (!finalHeaders.has("content-type")) {
      finalHeaders.set("content-type", "application/json");
    }
  } else if (body !== undefined && !finalHeaders.has("content-type")) {
    finalHeaders.set("content-type", "application/json");
  }

  const init: RequestInit = { method, headers: finalHeaders };
  if (payload !== undefined) init.body = payload;

  const request = new Request(`http://localhost${path}`, init);
  return Promise.resolve(handler(request, socketIp));
}

/** Parse a JSON response body with proper typing. */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export interface TextResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** GET helper returning a supertest-like shape for text assertions. */
export async function get(handler: Handler, path: string): Promise<TextResponse> {
  const res = await call(handler, path);
  return { status: res.status, headers: res.headers, text: await res.text() };
}
