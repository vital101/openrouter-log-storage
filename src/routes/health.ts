import { Router } from "express";
import { sql, type Kysely } from "kysely";
import type { Database } from "../types.js";

export function healthRouter(db: Kysely<Database>) {
  const router = Router();

  router.get("/healthz", async (_req, res) => {
    try {
      await sql`SELECT 1`.execute(db);
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "down" });
    }
  });

  return router;
}