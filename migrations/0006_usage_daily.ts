import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("usage_daily")
    .ifNotExists()
    .addColumn("day", "date", (col) => col.notNull())
    .addColumn("model", "text", (col) => col.notNull())
    .addColumn("calls", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("input_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("output_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("cached_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("reasoning_tokens", "bigint", (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn("total_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn(
      "total_cost",
      sql`numeric(18,8)`,
      (col) => col.notNull().defaultTo(0),
    )
    .addPrimaryKeyConstraint("usage_daily_pk", ["day", "model"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("usage_daily").ifExists().execute();
}
