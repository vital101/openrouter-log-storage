import { Router } from "express";
import type { Kysely } from "kysely";
import type { Database } from "../types.js";

const TEST_CONNECTION_HEADER = "x-test-connection";

export function webhookRouter(db: Kysely<Database>, authHeaderName: string) {
  const router = Router();

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
        payload: JSON.stringify(payload),
        auth_header_name: authHeaderName,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    res.status(200).json({ ok: true, id: Number(result.id) });
  });

  return router;
}