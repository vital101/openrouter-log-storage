import { Router } from "express";
import rateLimit from "express-rate-limit";
import type { Kysely } from "kysely";
import type { Database } from "../types.js";
import { sanitizeJsonValue } from "../sanitize.js";

const TEST_CONNECTION_HEADER = "x-test-connection";

export function webhookRouter(db: Kysely<Database>, authHeaderName: string, rateLimitPerMin: number = 60) {
  const router = Router();

  if (rateLimitPerMin > 0) {
    router.use(
      rateLimit({
        windowMs: 60_000,
        max: rateLimitPerMin,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "rate_limited" },
        skip: (req) => req.get(TEST_CONNECTION_HEADER)?.toLowerCase() === "true",
      }),
    );
  }

  router.post("/webhook/openrouter", async (req, res) => {
    if (req.get(TEST_CONNECTION_HEADER)?.toLowerCase() === "true") {
      res.status(200).json({ ok: true, test: true });
      return;
    }

    const payload = req.body;
    if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }

    const result = await db
      .insertInto("raw_events")
      .values({
        payload: JSON.stringify(sanitizeJsonValue(payload)),
        auth_header_name: authHeaderName,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    res.status(200).json({ ok: true, id: Number(result.id) });
  });

  return router;
}