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

    await refreshUsageDailyBuckets(db, [...spanIdsByTraceId.keys()]);
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
    agg AS (
      SELECT (g.start_time AT TIME ZONE 'UTC')::date AS day,
             COALESCE(g.request_model, '(unknown)') AS model,
             COUNT(*)::bigint AS calls,
             COALESCE(SUM(g.input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(g.output_tokens), 0)::bigint AS output_tokens,
             COALESCE(SUM(g.cached_tokens), 0)::bigint AS cached_tokens,
             COALESCE(SUM(g.reasoning_tokens), 0)::bigint AS reasoning_tokens,
             COALESCE(SUM(g.total_tokens), 0)::bigint AS total_tokens,
             COALESCE(SUM(g.total_cost), 0) AS total_cost
      FROM llm_generations g
      WHERE g.start_time >= (SELECT (min(t.day)::timestamp AT TIME ZONE 'UTC') FROM touched t)
        AND g.start_time < (SELECT ((max(t.day)::timestamp AT TIME ZONE 'UTC') + interval '1 day') FROM touched t)
      GROUP BY 1, 2
    )
    INSERT INTO usage_daily (day, model, calls, input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, total_cost)
    SELECT a.day, a.model, a.calls, a.input_tokens, a.output_tokens, a.cached_tokens, a.reasoning_tokens, a.total_tokens, a.total_cost
    FROM agg a
    JOIN touched t USING (day, model)
    ON CONFLICT (day, model) DO UPDATE SET
      calls = EXCLUDED.calls,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cached_tokens = EXCLUDED.cached_tokens,
      reasoning_tokens = EXCLUDED.reasoning_tokens,
      total_tokens = EXCLUDED.total_tokens,
      total_cost = EXCLUDED.total_cost
  `.execute(db);
}
