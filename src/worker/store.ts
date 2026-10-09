import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../types.js";
import type { ParsedGeneration, ParsedPayload, ParsedTrace } from "./otel.js";

export function forJsonb(value: unknown): unknown {
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

interface CoalescedTrace {
  trace: ParsedTrace;
  generations: Map<string, ParsedGeneration>;
}

function coalesceByOpenrouterTraceId(parsed: ParsedPayload[]): CoalescedTrace[] {
  const byId = new Map<string, CoalescedTrace>();
  for (const p of parsed) {
    const id = p.trace.openrouterTraceId;
    const existing = byId.get(id);
    if (existing) {
      existing.trace = { ...existing.trace, ...p.trace };
      for (const g of p.generations) {
        if (!existing.generations.has(g.spanId)) {
          existing.generations.set(g.spanId, g);
        }
      }
    } else {
      const generations = new Map<string, ParsedGeneration>();
      for (const g of p.generations) {
        generations.set(g.spanId, g);
      }
      byId.set(id, { trace: p.trace, generations });
    }
  }
  return [...byId.values()];
}

export async function storeParsedTraces(
  db: Kysely<Database>,
  rawEventId: number,
  parsed: ParsedPayload[],
): Promise<void> {
  if (parsed.length === 0) return;

  const coalesced = coalesceByOpenrouterTraceId(parsed);
  const traces = coalesced.map((c) => c.trace);

  const traceRows = await db
    .insertInto("traces")
    .values(
      traces.map((t) => ({
        openrouter_trace_id: t.openrouterTraceId,
        otel_trace_id: t.otelTraceId,
        service_name: t.serviceName,
        trace_name: t.traceName,
        tags: forJsonb(t.tags),
        metadata: forJsonb(t.metadata),
        session_id: t.sessionId,
        user_id: t.userId,
        entity_id: t.entityId,
        api_key_name: t.apiKeyName,
        provider_name: t.providerName,
        provider_slug: t.providerSlug,
        environment: t.environment,
        source: t.source,
        received_at: new Date(),
        raw_event_id: rawEventId,
      })),
    )
    .onConflict((oc) =>
      oc.column("openrouter_trace_id").doUpdateSet({
        otel_trace_id: sql`excluded.otel_trace_id`,
        service_name: sql`excluded.service_name`,
        trace_name: sql`excluded.trace_name`,
        tags: sql`excluded.tags`,
        metadata: sql`excluded.metadata`,
        session_id: sql`excluded.session_id`,
        user_id: sql`excluded.user_id`,
        entity_id: sql`excluded.entity_id`,
        api_key_name: sql`excluded.api_key_name`,
        provider_name: sql`excluded.provider_name`,
        provider_slug: sql`excluded.provider_slug`,
        environment: sql`excluded.environment`,
        source: sql`excluded.source`,
        raw_event_id: sql`excluded.raw_event_id`,
      }),
    )
    .returning(["id", "openrouter_trace_id"])
    .execute();

  const traceIdMap = new Map<string, string>();
  for (const row of traceRows) {
    traceIdMap.set(row.openrouter_trace_id, row.id);
  }

  const genValues = coalesced.flatMap((c) => {
    const traceId = traceIdMap.get(c.trace.openrouterTraceId);
    if (!traceId) return [];
    return [...c.generations.values()].map((g) => ({
      trace_id: traceId,
      span_id: g.spanId,
      otel_trace_id: g.otelTraceId,
      name: g.name,
      kind: g.kind,
      status_code: g.statusCode,
      span_type: g.spanType,
      span_level: g.spanLevel,
      start_time: g.startTime,
      end_time: g.endTime,
      duration_ms: g.durationMs,
      operation_name: g.operationName,
      system: g.system,
      provider_name: g.providerName,
      request_model: g.requestModel,
      response_model: g.responseModel,
      response_id: g.responseId,
      finish_reason: g.finishReason,
      finish_reasons: forJsonb(g.finishReasons),
      temperature: g.temperature,
      max_tokens: g.maxTokens,
      top_p: g.topP,
      frequency_penalty: g.frequencyPenalty,
      presence_penalty: g.presencePenalty,
      input_tokens: g.inputTokens,
      output_tokens: g.outputTokens,
      total_tokens: g.totalTokens,
      cached_tokens: g.cachedTokens,
      reasoning_tokens: g.reasoningTokens,
      input_cost: g.inputCost,
      output_cost: g.outputCost,
      total_cost: g.totalCost,
      input_unit_price: c.trace.inputUnitPrice,
      output_unit_price: c.trace.outputUnitPrice,
      prompt: forJsonb(g.prompt),
      completion: forJsonb(g.completion),
    }));
  });

  if (genValues.length > 0) {
    await db
      .insertInto("llm_generations")
      .values(genValues)
      .onConflict((oc) =>
        oc.columns(["trace_id", "span_id"]).doUpdateSet({
          otel_trace_id: sql`excluded.otel_trace_id`,
          name: sql`excluded.name`,
          kind: sql`excluded.kind`,
          status_code: sql`excluded.status_code`,
          span_type: sql`excluded.span_type`,
          span_level: sql`excluded.span_level`,
          start_time: sql`excluded.start_time`,
          end_time: sql`excluded.end_time`,
          duration_ms: sql`excluded.duration_ms`,
          operation_name: sql`excluded.operation_name`,
          system: sql`excluded.system`,
          provider_name: sql`excluded.provider_name`,
          request_model: sql`excluded.request_model`,
          response_model: sql`excluded.response_model`,
          response_id: sql`excluded.response_id`,
          finish_reason: sql`excluded.finish_reason`,
          finish_reasons: sql`excluded.finish_reasons`,
          temperature: sql`excluded.temperature`,
          max_tokens: sql`excluded.max_tokens`,
          top_p: sql`excluded.top_p`,
          frequency_penalty: sql`excluded.frequency_penalty`,
          presence_penalty: sql`excluded.presence_penalty`,
          input_tokens: sql`excluded.input_tokens`,
          output_tokens: sql`excluded.output_tokens`,
          total_tokens: sql`excluded.total_tokens`,
          cached_tokens: sql`excluded.cached_tokens`,
          reasoning_tokens: sql`excluded.reasoning_tokens`,
          input_cost: sql`excluded.input_cost`,
          output_cost: sql`excluded.output_cost`,
          total_cost: sql`excluded.total_cost`,
          input_unit_price: sql`excluded.input_unit_price`,
          output_unit_price: sql`excluded.output_unit_price`,
          prompt: sql`excluded.prompt`,
          completion: sql`excluded.completion`,
        }),
      )
      .execute();

    const spanIdsByTraceId = new Map<string, string[]>();
    for (const gen of genValues) {
      const existing = spanIdsByTraceId.get(gen.trace_id);
      if (existing) {
        existing.push(gen.span_id);
      } else {
        spanIdsByTraceId.set(gen.trace_id, [gen.span_id]);
      }
    }

    for (const [traceId, spanIds] of spanIdsByTraceId) {
      await db
        .deleteFrom("llm_generations")
        .where("trace_id", "=", traceId)
        .where(sql<boolean>`span_id <> all(${spanIds}::text[])`)
        .execute();
    }

    const touchedTraceIds = [...spanIdsByTraceId.keys()];
    await refreshUsageDailyBuckets(db, touchedTraceIds);
    await refreshUsageHourlyBuckets(db, touchedTraceIds);
  }
}

async function refreshUsageDailyBuckets(
  db: Kysely<Database>,
  traceIds: string[],
): Promise<void> {
  if (traceIds.length === 0) return;

  await sql`
    WITH touched AS (
      SELECT DISTINCT (start_time AT TIME ZONE 'UTC')::date AS day,
             COALESCE(request_model, '(unknown)') AS model
      FROM llm_generations
      WHERE trace_id = ANY(${traceIds}::uuid[])
    ),
    bounds AS (
      SELECT
        min(day)::timestamp AT TIME ZONE 'UTC' AS min_t,
        (max(day)::timestamp AT TIME ZONE 'UTC') + interval '1 day' AS max_t
      FROM touched
    ),
    base AS (
      SELECT
        (g.start_time AT TIME ZONE 'UTC')::date AS day,
        COALESCE(g.request_model, '(unknown)') AS model,
        g.duration_ms,
        COALESCE(g.status_code::text, '(none)') AS status_key,
        COALESCE(g.finish_reason, '(none)') AS finish_key,
        COALESCE(g.provider_name, '(unknown)') AS provider_key,
        COALESCE(g.response_model, '(unknown)') AS response_key,
        length(g.prompt::text) AS prompt_len,
        length(g.completion::text) AS completion_len,
        g.input_tokens, g.output_tokens, g.cached_tokens, g.reasoning_tokens,
        g.total_tokens, g.total_cost
      FROM llm_generations g, bounds b
      WHERE g.start_time >= b.min_t AND g.start_time < b.max_t
    ),
    agg AS (
      SELECT day, model,
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
    JOIN touched t USING (day, model)
    JOIN status_mix s USING (day, model)
    JOIN finish_mix f USING (day, model)
    JOIN provider_mix p USING (day, model)
    JOIN response_mix r USING (day, model)
    ON CONFLICT (day, model) DO UPDATE SET
      calls = EXCLUDED.calls,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cached_tokens = EXCLUDED.cached_tokens,
      reasoning_tokens = EXCLUDED.reasoning_tokens,
      total_tokens = EXCLUDED.total_tokens,
      total_cost = EXCLUDED.total_cost,
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

async function refreshUsageHourlyBuckets(
  db: Kysely<Database>,
  traceIds: string[],
): Promise<void> {
  if (traceIds.length === 0) return;

  await sql`
    WITH touched AS (
      SELECT DISTINCT date_trunc('hour', start_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour,
             COALESCE(request_model, '(unknown)') AS model
      FROM llm_generations
      WHERE trace_id = ANY(${traceIds}::uuid[])
    ),
    bounds AS (
      SELECT min(hour) AS min_h, max(hour) + interval '1 hour' AS max_h FROM touched
    ),
    agg AS (
      SELECT date_trunc('hour', g.start_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour,
             COALESCE(g.request_model, '(unknown)') AS model,
             COUNT(*)::bigint AS calls,
             COALESCE(SUM(g.input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(g.output_tokens), 0)::bigint AS output_tokens,
             COALESCE(SUM(g.cached_tokens), 0)::bigint AS cached_tokens,
             COALESCE(SUM(g.reasoning_tokens), 0)::bigint AS reasoning_tokens,
             COALESCE(SUM(g.total_tokens), 0)::bigint AS total_tokens,
             COALESCE(SUM(g.total_cost), 0) AS total_cost
      FROM llm_generations g, bounds b
      WHERE g.start_time >= b.min_h AND g.start_time < b.max_h
      GROUP BY 1, 2
    )
    INSERT INTO usage_hourly (hour, model, calls, input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, total_cost)
    SELECT a.hour, a.model, a.calls, a.input_tokens, a.output_tokens, a.cached_tokens, a.reasoning_tokens, a.total_tokens, a.total_cost
    FROM agg a
    JOIN touched t USING (hour, model)
    ON CONFLICT (hour, model) DO UPDATE SET
      calls = EXCLUDED.calls,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cached_tokens = EXCLUDED.cached_tokens,
      reasoning_tokens = EXCLUDED.reasoning_tokens,
      total_tokens = EXCLUDED.total_tokens,
      total_cost = EXCLUDED.total_cost
  `.execute(db);
}
