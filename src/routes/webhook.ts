import type { Kysely } from "kysely";
import { json, readJsonBody, type Handler } from "../http.js";
import type { Database } from "../types.js";
import { sanitizeJsonValue } from "../sanitize.js";

const TEST_CONNECTION_HEADER = "x-test-connection";

export interface WebhookOptions {
  db: Kysely<Database>;
  authHeaderName: string;
  bodyLimitBytes: number;
}

export function webhookHandler(options: WebhookOptions): Handler {
  const { db, authHeaderName, bodyLimitBytes } = options;

  return async (req) => {
    if (req.headers.get(TEST_CONNECTION_HEADER)?.toLowerCase() === "true") {
      return json({ ok: true, test: true });
    }

    const payload = await readJsonBody(req, bodyLimitBytes);
    if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ error: "invalid_payload" }, 400);
    }

    const result = await db
      .insertInto("raw_events")
      .values({
        payload: JSON.stringify(sanitizeJsonValue(payload)),
        auth_header_name: authHeaderName,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return json({ ok: true, id: Number(result.id) });
  };
}
