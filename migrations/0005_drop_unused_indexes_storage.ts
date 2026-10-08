import { Kysely, sql } from "kysely";

const DROPPED_INDEXES = [
  "llm_generations_trace_id_idx",
  "llm_generations_request_model_idx",
  "llm_generations_provider_name_idx",
  "traces_user_id_idx",
  "traces_session_id_idx",
] as const;

export async function up(db: Kysely<any>): Promise<void> {
  for (const indexName of DROPPED_INDEXES) {
    await db.schema.dropIndex(indexName).ifExists().execute();
  }

  await db.schema
    .createIndex("traces_raw_event_id_idx")
    .ifNotExists()
    .on("traces")
    .column("raw_event_id")
    .where(sql`raw_event_id IS NOT NULL`)
    .execute();

  await db.schema
    .alterTable("llm_generations")
    .dropColumn("raw_attributes")
    .execute();

  await sql`
    DO $$ BEGIN
      IF current_setting('server_version_num')::int >= 140000 THEN
        ALTER TABLE llm_generations ALTER COLUMN prompt SET COMPRESSION lz4;
        ALTER TABLE llm_generations ALTER COLUMN completion SET COMPRESSION lz4;
      END IF;
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("llm_generations")
    .addColumn("raw_attributes", "jsonb")
    .execute();

  await db.schema.dropIndex("traces_raw_event_id_idx").ifExists().execute();

  await db.schema
    .createIndex("llm_generations_trace_id_idx")
    .ifNotExists()
    .on("llm_generations")
    .column("trace_id")
    .execute();

  await db.schema
    .createIndex("llm_generations_request_model_idx")
    .ifNotExists()
    .on("llm_generations")
    .column("request_model")
    .execute();

  await db.schema
    .createIndex("llm_generations_provider_name_idx")
    .ifNotExists()
    .on("llm_generations")
    .column("provider_name")
    .execute();

  await db.schema
    .createIndex("traces_user_id_idx")
    .ifNotExists()
    .on("traces")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("traces_session_id_idx")
    .ifNotExists()
    .on("traces")
    .column("session_id")
    .execute();
}
