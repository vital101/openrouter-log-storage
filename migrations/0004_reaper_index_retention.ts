import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex("raw_events_processing_claimed_idx")
    .ifNotExists()
    .on("raw_events")
    .column("claimed_at")
    .where("processing_status", "=", "processing")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("raw_events_processing_claimed_idx").ifExists().execute();
}
