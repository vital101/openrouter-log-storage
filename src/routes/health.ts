import { sql, type Kysely } from "kysely";
import { json, type Handler } from "../http.js";
import type { Database } from "../types.js";

export function healthHandler(db: Kysely<Database>): Handler {
  return async () => {
    try {
      await sql`SELECT 1`.execute(db);
      return json({ status: "ok" });
    } catch {
      return json({ status: "down" }, 503);
    }
  };
}
