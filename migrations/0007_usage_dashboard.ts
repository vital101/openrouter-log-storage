import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("usage_daily")
    .addColumn("avg_duration_ms", "double precision")
    .addColumn("p50_duration_ms", "bigint")
    .addColumn("p95_duration_ms", "bigint")
    .addColumn("status_counts", "jsonb")
    .addColumn("finish_reason_counts", "jsonb")
    .addColumn("provider_counts", "jsonb")
    .addColumn("response_model_counts", "jsonb")
    .addColumn("prompt_chars", "bigint")
    .addColumn("completion_chars", "bigint")
    .execute();

  await db.schema
    .createTable("usage_hourly")
    .ifNotExists()
    .addColumn("hour", "timestamptz", (col) => col.notNull())
    .addColumn("model", "text", (col) => col.notNull())
    .addColumn("calls", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("input_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("output_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("cached_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("reasoning_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("total_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn(
      "total_cost",
      sql`numeric(18,8)`,
      (col) => col.notNull().defaultTo(0),
    )
    .addPrimaryKeyConstraint("usage_hourly_pk", ["hour", "model"])
    .execute();

  await db.schema
    .createIndex("llm_generations_total_cost_idx")
    .ifNotExists()
    .on("llm_generations")
    .column("total_cost")
    .where(sql`total_cost IS NOT NULL`)
    .execute();

  await sql`
    WITH base AS (
      SELECT
        (start_time AT TIME ZONE 'UTC')::date AS day,
        COALESCE(request_model, '(unknown)') AS model,
        duration_ms,
        COALESCE(status_code::text, '(none)') AS status_key,
        COALESCE(finish_reason, '(none)') AS finish_key,
        COALESCE(provider_name, '(unknown)') AS provider_key,
        COALESCE(response_model, '(unknown)') AS response_key,
        length(prompt::text) AS prompt_len,
        length(completion::text) AS completion_len,
        input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, total_cost
      FROM llm_generations
    ),
    agg AS (
      SELECT
        day, model,
        COUNT(*)::bigint AS calls,
        COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
        COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        AVG(duration_ms) AS avg_duration_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::bigint AS p50_duration_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::bigint AS p95_duration_ms,
        COALESCE(SUM(prompt_len), 0)::bigint AS prompt_chars,
        COALESCE(SUM(completion_len), 0)::bigint AS completion_chars
      FROM base GROUP BY day, model
    ),
    status_mix AS (
      SELECT day, model, jsonb_object_agg(status_key, cnt) AS status_counts
      FROM (SELECT day, model, status_key, COUNT(*)::bigint AS cnt FROM base GROUP BY 1,2,3) t
      GROUP BY day, model
    ),
    finish_mix AS (
      SELECT day, model, jsonb_object_agg(finish_key, cnt) AS finish_reason_counts
      FROM (SELECT day, model, finish_key, COUNT(*)::bigint AS cnt FROM base GROUP BY 1,2,3) t
      GROUP BY day, model
    ),
    provider_mix AS (
      SELECT day, model, jsonb_object_agg(provider_key, cnt) AS provider_counts
      FROM (SELECT day, model, provider_key, COUNT(*)::bigint AS cnt FROM base GROUP BY 1,2,3) t
      GROUP BY day, model
    ),
    response_mix AS (
      SELECT day, model, jsonb_object_agg(response_key, cnt) AS response_model_counts
      FROM (SELECT day, model, response_key, COUNT(*)::bigint AS cnt FROM base GROUP BY 1,2,3) t
      GROUP BY day, model
    )
    INSERT INTO usage_daily (day, model, calls, input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, total_cost,
                              avg_duration_ms, p50_duration_ms, p95_duration_ms,
                              status_counts, finish_reason_counts, provider_counts, response_model_counts,
                              prompt_chars, completion_chars)
    SELECT
      a.day, a.model, a.calls, a.input_tokens, a.output_tokens, a.cached_tokens, a.reasoning_tokens, a.total_tokens, a.total_cost,
      a.avg_duration_ms, a.p50_duration_ms, a.p95_duration_ms,
      s.status_counts, f.finish_reason_counts, p.provider_counts, r.response_model_counts,
      a.prompt_chars, a.completion_chars
    FROM agg a
    JOIN status_mix s USING (day, model)
    JOIN finish_mix f USING (day, model)
    JOIN provider_mix p USING (day, model)
    JOIN response_mix r USING (day, model)
    ON CONFLICT (day, model) DO UPDATE SET
      avg_duration_ms = EXCLUDED.avg_duration_ms,
      p50_duration_ms = EXCLUDED.p50_duration_ms,
      p95_duration_ms = EXCLUDED.p95_duration_ms,
      status_counts = EXCLUDED.status_counts,
      finish_reason_counts = EXCLUDED.finish_reason_counts,
      provider_counts = EXCLUDED.provider_counts,
      response_model_counts = EXCLUDED.response_model_counts,
      prompt_chars = EXCLUDED.prompt_chars,
      completion_chars = EXCLUDED.completion_chars
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("llm_generations_total_cost_idx").ifExists().execute();
  await db.schema.dropTable("usage_hourly").ifExists().execute();
  await db.schema
    .alterTable("usage_daily")
    .dropColumn("completion_chars")
    .dropColumn("prompt_chars")
    .dropColumn("response_model_counts")
    .dropColumn("provider_counts")
    .dropColumn("finish_reason_counts")
    .dropColumn("status_counts")
    .dropColumn("p95_duration_ms")
    .dropColumn("p50_duration_ms")
    .dropColumn("avg_duration_ms")
    .execute();
}