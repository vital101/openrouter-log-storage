import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("raw_events")
    .addColumn("claimed_at", "timestamptz")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("raw_events")
    .dropColumn("claimed_at")
    .execute();
}
