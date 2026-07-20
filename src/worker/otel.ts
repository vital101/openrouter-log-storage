import crypto from "node:crypto";

export interface ParsedTrace {
  openrouterTraceId: string;
  otelTraceId: string | null;
  serviceName: string | null;
  traceName: string | null;
  tags: unknown | null;
  metadata: Record<string, unknown> | null;
  sessionId: string | null;
  userId: string | null;
  entityId: string | null;
  apiKeyName: string | null;
  providerName: string | null;
  providerSlug: string | null;
  environment: string | null;
  source: string | null;
  inputUnitPrice: number | null;
  outputUnitPrice: number | null;
}

export interface ParsedGeneration {
  spanId: string;
  otelTraceId: string | null;
  name: string | null;
  kind: number | null;
  statusCode: number | null;
  spanType: string | null;
  spanLevel: string | null;
  startTime: Date | null;
  endTime: Date | null;
  durationMs: number | null;
  operationName: string | null;
  system: string | null;
  providerName: string | null;
  requestModel: string | null;
  responseModel: string | null;
  responseId: string | null;
  finishReason: string | null;
  finishReasons: unknown | null;
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  inputCost: number | null;
  outputCost: number | null;
  totalCost: number | null;
  prompt: unknown | null;
  completion: unknown | null;
  rawAttributes: Record<string, unknown>;
}

export interface ParsedPayload {
  trace: ParsedTrace;
  generations: ParsedGeneration[];
}

function getAttrValue(
  value: Record<string, unknown> | undefined,
): unknown {
  if (!value) return null;

  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.intValue === "string") return Number(value.intValue);
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  const arrVal = value.arrayValue;
  if (
    arrVal &&
    typeof arrVal === "object" &&
    Array.isArray((arrVal as { values?: unknown[] }).values)
  ) {
    return (arrVal as { values: unknown[] }).values.map((v: unknown) =>
      getAttrValue(v as Record<string, unknown>),
    );
  }

  return null;
}

function flattenAttributes(attrs: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!Array.isArray(attrs)) return result;

  for (const attr of attrs) {
    if (!attr || typeof attr !== "object") continue;
    const a = attr as Record<string, unknown>;
    if (typeof a.key !== "string") continue;
    result[a.key] = getAttrValue(a.value as Record<string, unknown> | undefined);
  }

  return result;
}

function setNested(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (
      !(part in current) ||
      typeof current[part] !== "object" ||
      current[part] === null
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function buildMetadata(
  flat: Record<string, unknown>,
): Record<string, unknown> | null {
  const entries = Object.entries(flat).filter(([k]) =>
    k.startsWith("trace.metadata."),
  );
  if (entries.length === 0) return null;

  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    setNested(result, key.slice("trace.metadata.".length), value);
  }
  return result;
}

function parseUnixNano(nano: string | undefined): Date | null {
  if (!nano) return null;
  const ms = Number(nano) / 1_000_000;
  if (isNaN(ms)) return null;
  return new Date(ms);
}

function tryParseJson(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return isNaN(n) ? null : n;
  }
  return null;
}

export function parseOtelPayload(payload: unknown): ParsedPayload[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be a non-null object");
  }

  const root = payload as Record<string, unknown>;
  const resourceSpans = root.resourceSpans;
  if (!Array.isArray(resourceSpans)) {
    throw new Error("payload.resourceSpans must be an array");
  }

  const results: ParsedPayload[] = [];

  for (const rs of resourceSpans) {
    if (!rs || typeof rs !== "object") continue;

    const resourceSpan = rs as Record<string, unknown>;
    const resource = resourceSpan.resource as
      | Record<string, unknown>
      | undefined;
    const resourceAttrs = flattenAttributes(
      (resource?.attributes as unknown[]) ?? [],
    );

    const sessionId = (resourceAttrs["session.id"] as string) ?? null;
    const userId = (resourceAttrs["user.id"] as string) ?? null;
    const openrouterTraceIdRaw = resourceAttrs["openrouter.trace.id"];
    const traceName = (resourceAttrs["trace.name"] as string) ?? null;
    const serviceName = (resourceAttrs["service.name"] as string) ?? null;
    const tagsRaw = resourceAttrs["trace.tags"];
    const tags = typeof tagsRaw === "string" ? tryParseJson(tagsRaw) : tagsRaw;

    const entityId =
      (resourceAttrs["trace.metadata.openrouter.entity_id"] as string) ?? null;
    const apiKeyName =
      (resourceAttrs["trace.metadata.openrouter.api_key_name"] as string) ??
      null;
    const providerName =
      (resourceAttrs["trace.metadata.openrouter.provider_name"] as string) ??
      null;
    const providerSlug =
      (resourceAttrs["trace.metadata.openrouter.provider_slug"] as string) ??
      null;
    const environment =
      (resourceAttrs["trace.metadata.environment"] as string) ?? null;
    const source =
      (resourceAttrs["trace.metadata.source"] as string) ?? null;

    const inputUnitPrice =
      coerceNumber(
        resourceAttrs["trace.metadata.openrouter.input_unit_price"],
      ) ?? null;
    const outputUnitPrice =
      coerceNumber(
        resourceAttrs["trace.metadata.openrouter.output_unit_price"],
      ) ?? null;

    const metadata = buildMetadata(resourceAttrs);

    let openrouterTraceId: string;
    if (typeof openrouterTraceIdRaw === "string" && openrouterTraceIdRaw) {
      openrouterTraceId = openrouterTraceIdRaw;
    } else {
      openrouterTraceId = "";
    }

    const scopeSpans = resourceSpan.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;

    const generations: ParsedGeneration[] = [];
    let firstOtelTraceId: string | null = null;

    for (const ss of scopeSpans) {
      if (!ss || typeof ss !== "object") continue;
      const scopeSpan = ss as Record<string, unknown>;
      const spans = scopeSpan.spans;
      if (!Array.isArray(spans)) continue;

      for (const span of spans) {
        if (!span || typeof span !== "object") continue;
        const s = span as Record<string, unknown>;

        const spanId = (s.spanId as string) ?? "";
        const otelTraceId = (s.traceId as string) ?? null;
        const name = (s.name as string) ?? null;
        const kind = typeof s.kind === "number" ? s.kind : null;
        const statusObj = s.status as Record<string, unknown> | undefined;
        const statusCode =
          typeof statusObj?.code === "number" ? statusObj.code : null;
        const startTime = parseUnixNano(s.startTimeUnixNano as string);
        const endTime = parseUnixNano(s.endTimeUnixNano as string);

        let durationMs: number | null = null;
        if (startTime && endTime) {
          durationMs = Math.round(endTime.getTime() - startTime.getTime());
        }

        if (firstOtelTraceId === null && otelTraceId) {
          firstOtelTraceId = otelTraceId;
        }

        const spanAttrs = flattenAttributes(
          (s.attributes as unknown[]) ?? [],
        );

        const operationName =
          (spanAttrs["gen_ai.operation.name"] as string) ?? null;
        const system = (spanAttrs["gen_ai.system"] as string) ?? null;
        const genProviderName =
          (spanAttrs["gen_ai.provider.name"] as string) ?? null;
        const requestModel =
          (spanAttrs["gen_ai.request.model"] as string) ?? null;
        const responseModel =
          (spanAttrs["gen_ai.response.model"] as string) ?? null;
        const responseId =
          (spanAttrs["gen_ai.response.id"] as string) ?? null;
        const finishReason =
          (spanAttrs["gen_ai.response.finish_reason"] as string) ?? null;

        const finishReasonsRaw = spanAttrs["gen_ai.response.finish_reasons"];
        const finishReasons =
          typeof finishReasonsRaw === "string"
            ? tryParseJson(finishReasonsRaw)
            : finishReasonsRaw;

        const temperature =
          coerceNumber(spanAttrs["gen_ai.request.temperature"]) ?? null;
        const maxTokens = coerceNumber(spanAttrs["gen_ai.request.max_tokens"]);
        const topP =
          coerceNumber(spanAttrs["gen_ai.request.top_p"]) ?? null;
        const frequencyPenalty =
          coerceNumber(spanAttrs["gen_ai.request.frequency_penalty"]) ??
          null;
        const presencePenalty =
          coerceNumber(spanAttrs["gen_ai.request.presence_penalty"]) ??
          null;

        const inputTokens =
          coerceNumber(spanAttrs["gen_ai.usage.input_tokens"]) ?? null;
        const outputTokens =
          coerceNumber(spanAttrs["gen_ai.usage.output_tokens"]) ?? null;
        const totalTokens =
          coerceNumber(spanAttrs["gen_ai.usage.total_tokens"]) ?? null;
        const cachedTokens =
          coerceNumber(spanAttrs["gen_ai.usage.input_tokens.cached"]) ??
          null;
        const reasoningTokens =
          coerceNumber(spanAttrs["gen_ai.usage.output_tokens.reasoning"]) ??
          null;

        const inputCost =
          coerceNumber(spanAttrs["gen_ai.usage.input_cost"]) ?? null;
        const outputCost =
          coerceNumber(spanAttrs["gen_ai.usage.output_cost"]) ?? null;
        const totalCost =
          coerceNumber(spanAttrs["gen_ai.usage.total_cost"]) ?? null;

        const genAiPrompt = spanAttrs["gen_ai.prompt"];
        const traceInput = spanAttrs["trace.input"];
        const prompt = tryParseJson(
          genAiPrompt ?? traceInput ?? null,
        );

        const genAiCompletion = spanAttrs["gen_ai.completion"];
        const traceOutput = spanAttrs["trace.output"];
        const completion = tryParseJson(
          genAiCompletion ?? traceOutput ?? null,
        );

        const spanType = (spanAttrs["span.type"] as string) ?? null;
        const spanLevel = (spanAttrs["span.level"] as string) ?? null;

        const isMaxTokensInvalid =
          maxTokens !== null && isNaN(maxTokens);

        generations.push({
          spanId,
          otelTraceId,
          name,
          kind,
          statusCode,
          spanType,
          spanLevel,
          startTime,
          endTime,
          durationMs,
          operationName,
          system,
          providerName: genProviderName,
          requestModel,
          responseModel,
          responseId,
          finishReason,
          finishReasons,
          temperature,
          maxTokens: isMaxTokensInvalid ? null : maxTokens,
          topP,
          frequencyPenalty,
          presencePenalty,
          inputTokens,
          outputTokens,
          totalTokens,
          cachedTokens,
          reasoningTokens,
          inputCost,
          outputCost,
          totalCost,
          prompt,
          completion,
          rawAttributes: spanAttrs,
        });
      }
    }

    if (!openrouterTraceId) {
      openrouterTraceId = firstOtelTraceId ?? `unknown-${crypto.randomUUID()}`;
    }

    const finalSessionId =
      sessionId ??
      (generations.length > 0
        ? (generations[0]!.rawAttributes["session.id"] as string) ?? null
        : null);
    const finalUserId =
      userId ??
      (generations.length > 0
        ? (generations[0]!.rawAttributes["user.id"] as string) ?? null
        : null);

    const trace: ParsedTrace = {
      openrouterTraceId,
      otelTraceId: firstOtelTraceId,
      serviceName,
      traceName,
      tags,
      metadata,
      sessionId: finalSessionId,
      userId: finalUserId,
      entityId,
      apiKeyName,
      providerName,
      providerSlug,
      environment,
      source,
      inputUnitPrice,
      outputUnitPrice,
    };

    results.push({ trace, generations });
  }

  return results;
}
