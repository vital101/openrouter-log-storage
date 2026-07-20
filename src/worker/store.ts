import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../types.js";
import type { ParsedPayload } from "./otel.js";

function forJsonb(value: unknown): unknown {
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

export async function storeParsedTraces(
  db: Kysely<Database>,
  rawEventId: number,
  parsed: ParsedPayload[],
): Promise<void> {
  const traceRows = await db
    .insertInto("traces")
    .values(
      parsed.map((p) => ({
        openrouter_trace_id: p.trace.openrouterTraceId,
        otel_trace_id: p.trace.otelTraceId,
        service_name: p.trace.serviceName,
        trace_name: p.trace.traceName,
        tags: forJsonb(p.trace.tags),
        metadata: forJsonb(p.trace.metadata),
        session_id: p.trace.sessionId,
        user_id: p.trace.userId,
        entity_id: p.trace.entityId,
        api_key_name: p.trace.apiKeyName,
        provider_name: p.trace.providerName,
        provider_slug: p.trace.providerSlug,
        environment: p.trace.environment,
        source: p.trace.source,
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

  const genValues = parsed.flatMap((p) => {
    const traceId = traceIdMap.get(p.trace.openrouterTraceId);
    if (!traceId) return [];

    return p.generations.map((g) => ({
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
      input_unit_price: p.trace.inputUnitPrice,
      output_unit_price: p.trace.outputUnitPrice,
      prompt: forJsonb(g.prompt),
      completion: forJsonb(g.completion),
      raw_attributes: forJsonb(g.rawAttributes),
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
          raw_attributes: sql`excluded.raw_attributes`,
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
        .where("span_id", "not in", spanIds)
        .execute();
    }
  }
}
