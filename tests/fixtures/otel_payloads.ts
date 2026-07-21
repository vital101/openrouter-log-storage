import type { ParsedPayload } from "../../src/worker/otel.js";

export function makeStringAttr(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

export function makeIntAttr(key: string, value: number): Record<string, unknown> {
  return { key, value: { intValue: value } };
}

export function makeDoubleAttr(key: string, value: number): Record<string, unknown> {
  return { key, value: { doubleValue: value } };
}

export function makeBoolAttr(key: string, value: boolean): Record<string, unknown> {
  return { key, value: { boolValue: value } };
}

export function makeArrayAttr(
  key: string,
  values: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return { key, value: { arrayValue: { values } } };
}

export interface SpanOptions {
  spanId?: string;
  traceId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  statusCode?: number;
  attributes?: Array<Record<string, unknown>>;
}

export function makeSpan(opts: SpanOptions = {}): Record<string, unknown> {
  const span: Record<string, unknown> = {
    spanId: opts.spanId ?? "span-1",
    traceId: opts.traceId ?? "otel-trace-1",
    name: opts.name ?? "openrouter.chat",
    kind: opts.kind ?? 1,
    startTimeUnixNano: opts.startTimeUnixNano ?? "1700000000000000000",
    endTimeUnixNano: opts.endTimeUnixNano ?? "1700000001000000000",
  };
  if (opts.statusCode !== undefined) {
    span.status = { code: opts.statusCode };
  }
  if (opts.attributes) {
    span.attributes = opts.attributes;
  }
  return span;
}

export interface ScopeSpanOptions {
  spans?: Array<Record<string, unknown>>;
}

export function makeScopeSpan(opts: ScopeSpanOptions = {}): Record<string, unknown> {
  return {
    spans: opts.spans ?? [makeSpan()],
  };
}

export interface ResourceSpanOptions {
  resourceAttributes?: Array<Record<string, unknown>>;
  scopeSpans?: Array<Record<string, unknown>>;
}

export function makeResourceSpan(
  opts: ResourceSpanOptions = {},
): Record<string, unknown> {
  return {
    resource: { attributes: opts.resourceAttributes ?? [] },
    scopeSpans: opts.scopeSpans ?? [makeScopeSpan()],
  };
}

export interface OtelPayloadOptions {
  resourceSpans?: Array<Record<string, unknown>>;
}

export function makeOtelPayload(opts: OtelPayloadOptions = {}): Record<string, unknown> {
  return {
    resourceSpans: opts.resourceSpans ?? [makeResourceSpan()],
  };
}

export function makeMinimalValidOtel(): Record<string, unknown> {
  return makeOtelPayload({
    resourceSpans: [
      makeResourceSpan({
        resourceAttributes: [
          makeStringAttr("openrouter.trace.id", "or-trace-1"),
          makeStringAttr("service.name", "test-service"),
        ],
        scopeSpans: [
          makeScopeSpan({
            spans: [
              makeSpan({
                spanId: "span-A",
                traceId: "otel-trace-1",
                attributes: [
                  makeStringAttr("gen_ai.operation.name", "chat"),
                  makeStringAttr("gen_ai.system", "openrouter"),
                  makeStringAttr("gen_ai.provider.name", "openai"),
                  makeStringAttr("gen_ai.request.model", "gpt-4o"),
                  makeStringAttr("gen_ai.response.model", "gpt-4o-2024-08-06"),
                  makeStringAttr("gen_ai.response.finish_reason", "stop"),
                  makeIntAttr("gen_ai.usage.input_tokens", 100),
                  makeIntAttr("gen_ai.usage.output_tokens", 50),
                  makeIntAttr("gen_ai.usage.total_tokens", 150),
                  makeDoubleAttr("gen_ai.request.temperature", 0.7),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

export function makeParsedTraceFor(
  openrouterTraceId: string,
  spanIds: string[],
): ParsedPayload[] {
  return [
    {
      trace: {
        openrouterTraceId,
        otelTraceId: "otel-trace-1",
        serviceName: "test",
        traceName: null,
        tags: null,
        metadata: null,
        sessionId: null,
        userId: null,
        entityId: null,
        apiKeyName: null,
        providerName: null,
        providerSlug: null,
        environment: null,
        source: null,
        inputUnitPrice: null,
        outputUnitPrice: null,
      },
      generations: spanIds.map((spanId, i) => ({
        spanId,
        otelTraceId: "otel-trace-1",
        name: "openrouter.chat",
        kind: 1,
        statusCode: 1,
        spanType: null,
        spanLevel: null,
        startTime: new Date(1_700_000_000_000 + i * 1000),
        endTime: new Date(1_700_000_001_000 + i * 1000),
        durationMs: 1000,
        operationName: "chat",
        system: "openrouter",
        providerName: "openai",
        requestModel: "gpt-4o",
        responseModel: "gpt-4o-2024-08-06",
        responseId: null,
        finishReason: "stop",
        finishReasons: null,
        temperature: 0.7,
        maxTokens: 1000,
        topP: null,
        frequencyPenalty: null,
        presencePenalty: null,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cachedTokens: null,
        reasoningTokens: null,
        inputCost: 0.001,
        outputCost: 0.002,
        totalCost: 0.003,
        prompt: [{ role: "user", content: "hi" }],
        completion: [{ role: "assistant", content: "hello" }],
        rawAttributes: { "gen_ai.system": "openrouter" },
      })),
    },
  ];
}
