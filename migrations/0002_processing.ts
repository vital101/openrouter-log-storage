import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("raw_events")
    .addColumn("next_attempt_at", "timestamptz")
    .execute();

  await db.schema.dropIndex("raw_events_pending_idx").ifExists().execute();

  await db.schema
    .createIndex("raw_events_claim_idx")
    .ifNotExists()
    .on("raw_events")
    .columns(["next_attempt_at", "received_at"])
    .where("processing_status", "=", "pending")
    .execute();

  await db.schema
    .createTable("traces")
    .ifNotExists()
    .addColumn("id", "uuid", (col) =>
      col.notNull().primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("openrouter_trace_id", "text", (col) =>
      col.notNull().unique(),
    )
    .addColumn("otel_trace_id", "text")
    .addColumn("service_name", "text")
    .addColumn("trace_name", "text")
    .addColumn("tags", "jsonb")
    .addColumn("metadata", "jsonb")
    .addColumn("session_id", "text")
    .addColumn("user_id", "text")
    .addColumn("entity_id", "text")
    .addColumn("api_key_name", "text")
    .addColumn("provider_name", "text")
    .addColumn("provider_slug", "text")
    .addColumn("environment", "text")
    .addColumn("source", "text")
    .addColumn("received_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("raw_event_id", "integer", (col) =>
      col.references("raw_events.id").onDelete("set null"),
    )
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

  await db.schema
    .createIndex("traces_received_at_idx")
    .ifNotExists()
    .on("traces")
    .column("received_at")
    .execute();

  await db.schema
    .createTable("llm_generations")
    .ifNotExists()
    .addColumn("id", "uuid", (col) =>
      col.notNull().primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("trace_id", "uuid", (col) =>
      col.notNull().references("traces.id").onDelete("cascade"),
    )
    .addColumn("span_id", "text", (col) => col.notNull())
    .addColumn("otel_trace_id", "text")
    .addColumn("name", "text")
    .addColumn("kind", "smallint")
    .addColumn("status_code", "smallint")
    .addColumn("span_type", "text")
    .addColumn("span_level", "text")
    .addColumn("start_time", "timestamptz")
    .addColumn("end_time", "timestamptz")
    .addColumn("duration_ms", "integer")
    .addColumn("operation_name", "text")
    .addColumn("system", "text")
    .addColumn("provider_name", "text")
    .addColumn("request_model", "text")
    .addColumn("response_model", "text")
    .addColumn("response_id", "text")
    .addColumn("finish_reason", "text")
    .addColumn("finish_reasons", "jsonb")
    .addColumn("temperature", "double precision")
    .addColumn("max_tokens", "integer")
    .addColumn("top_p", "double precision")
    .addColumn("frequency_penalty", "double precision")
    .addColumn("presence_penalty", "double precision")
    .addColumn("input_tokens", "integer")
    .addColumn("output_tokens", "integer")
    .addColumn("total_tokens", "integer")
    .addColumn("cached_tokens", "integer")
    .addColumn("reasoning_tokens", "integer")
    .addColumn("input_cost", "numeric(18,8)")
    .addColumn("output_cost", "numeric(18,8)")
    .addColumn("total_cost", "numeric(18,8)")
    .addColumn("input_unit_price", "numeric(18,8)")
    .addColumn("output_unit_price", "numeric(18,8)")
    .addColumn("prompt", "jsonb")
    .addColumn("completion", "jsonb")
    .addColumn("raw_attributes", "jsonb")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("llm_generations_trace_span_uniq")
    .ifNotExists()
    .on("llm_generations")
    .columns(["trace_id", "span_id"])
    .unique()
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
    .createIndex("llm_generations_start_time_idx")
    .ifNotExists()
    .on("llm_generations")
    .column("start_time")
    .execute();

  await db.schema
    .createIndex("llm_generations_trace_id_idx")
    .ifNotExists()
    .on("llm_generations")
    .column("trace_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("llm_generations").ifExists().execute();
  await db.schema.dropTable("traces").ifExists().execute();

  await db.schema.dropIndex("raw_events_claim_idx").ifExists().execute();

  await db.schema
    .createIndex("raw_events_pending_idx")
    .ifNotExists()
    .on("raw_events")
    .column("received_at")
    .where("processing_status", "=", "pending")
    .execute();

  await db.schema
    .alterTable("raw_events")
    .dropColumn("next_attempt_at")
    .execute();
}
