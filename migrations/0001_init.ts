import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("raw_events")
    .ifNotExists()
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("received_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("auth_header_name", "text")
    .addColumn("payload", "jsonb", (col) => col.notNull())
    .addColumn("processing_status", "text", (col) =>
      col.notNull().defaultTo("pending"),
    )
    .addColumn("processed_at", "timestamptz")
    .addColumn("processing_error", "text")
    .addColumn("attempt_count", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  await db.schema
    .createIndex("raw_events_pending_idx")
    .ifNotExists()
    .on("raw_events")
    .column("received_at")
    .where("processing_status", "=", "pending")
    .execute();

  await db.schema
    .createIndex("raw_events_received_idx")
    .ifNotExists()
    .on("raw_events")
    .column("received_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("raw_events").ifExists().execute();
}