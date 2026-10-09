import { describe, it, expect } from "vitest";
import { parseOtelPayload } from "../../src/worker/otel.js";
import {
  makeOtelPayload,
  makeResourceSpan,
  makeScopeSpan,
  makeSpan,
  makeStringAttr,
  makeIntAttr,
  makeDoubleAttr,
  makeBoolAttr,
  makeArrayAttr,
} from "../fixtures/otel_payloads.js";

describe("parseOtelPayload", () => {
  describe("input validation", () => {
    it("throws when payload is null", () => {
      expect(() => parseOtelPayload(null)).toThrow("payload must be a non-null object");
    });

    it("throws when payload is undefined", () => {
      expect(() => parseOtelPayload(undefined)).toThrow("payload must be a non-null object");
    });

    it("throws when payload is a primitive string", () => {
      expect(() => parseOtelPayload("hello")).toThrow("payload must be a non-null object");
    });

    it("throws when payload is a number", () => {
      expect(() => parseOtelPayload(42)).toThrow("payload must be a non-null object");
    });

    it("throws when payload is an array", () => {
      expect(() => parseOtelPayload([])).toThrow("payload must be a non-null object");
    });

    it("throws when payload is an array of objects", () => {
      expect(() => parseOtelPayload([{}])).toThrow("payload must be a non-null object");
    });

    it("throws when resourceSpans is missing", () => {
      expect(() => parseOtelPayload({})).toThrow("payload.resourceSpans must be an array");
    });

    it("throws when resourceSpans is not an array", () => {
      expect(() => parseOtelPayload({ resourceSpans: "nope" })).toThrow(
        "payload.resourceSpans must be an array",
      );
    });

    it("returns empty array when resourceSpans is empty", () => {
      expect(parseOtelPayload({ resourceSpans: [] })).toEqual([]);
    });
  });

  describe("empty / minimal payloads", () => {
    it("returns empty array when a resourceSpan has no scopeSpans (it is skipped)", () => {
      const result = parseOtelPayload({
        resourceSpans: [{ resource: { attributes: [] } }],
      });
      expect(result).toEqual([]);
    });

    it("skips a resourceSpan with no openrouter.trace.id and no spans (no useful trace identifier)", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          { resource: { attributes: [] }, scopeSpans: [] },
        ],
      });
      expect(result).toEqual([]);
    });

    it("emits a trace (with empty generations) when openrouter.trace.id is set but no spans are present", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [makeStringAttr("openrouter.trace.id", "or-explicit")],
            },
            scopeSpans: [],
          },
        ],
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.trace.openrouterTraceId).toBe("or-explicit");
      expect(result[0]?.generations).toEqual([]);
    });

    it("returns one result per resourceSpan", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: { attributes: [makeStringAttr("openrouter.trace.id", "a")] },
            scopeSpans: [makeScopeSpan({ spans: [makeSpan({ spanId: "s1" })] })],
          },
          {
            resource: { attributes: [makeStringAttr("openrouter.trace.id", "b")] },
            scopeSpans: [makeScopeSpan({ spans: [makeSpan({ spanId: "s2" })] })],
          },
        ],
      });
      expect(result).toHaveLength(2);
      expect(result[0]?.trace.openrouterTraceId).toBe("a");
      expect(result[1]?.trace.openrouterTraceId).toBe("b");
    });
  });

  describe("attribute value parsing", () => {
    it("extracts stringValue", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: { attributes: [makeStringAttr("service.name", "svc")] },
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [makeStringAttr("gen_ai.system", "openrouter")],
                  }),
                ],
              }),
            ],
          },
        ],
      });
      expect(result[0]?.trace.serviceName).toBe("svc");
      expect(result[0]?.generations[0]?.system).toBe("openrouter");
    });

    it("extracts intValue as a number", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [makeSpan({ attributes: [makeIntAttr("gen_ai.usage.input_tokens", 123)] })],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.inputTokens).toBe(123);
    });

    it("extracts intValue as a string and coerces to number", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.usage.input_tokens", value: { intValue: "456" } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.inputTokens).toBe(456);
    });

    it("extracts doubleValue", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [makeSpan({ attributes: [makeDoubleAttr("gen_ai.request.temperature", 0.75)] })],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.temperature).toBe(0.75);
    });

    it("extracts boolValue", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "trace.tags", value: { boolValue: true } }],
            },
            scopeSpans: [makeScopeSpan()],
          },
        ],
      });
      expect(result[0]?.trace.tags).toBe(true);
    });

    it("extracts arrayValue with mixed value kinds", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [
                makeArrayAttr("trace.tags", [
                  { stringValue: "a" },
                  { intValue: 2 },
                  { boolValue: false },
                ]),
              ],
            },
            scopeSpans: [makeScopeSpan()],
          },
        ],
      });
      expect(result[0]?.trace.tags).toEqual(["a", 2, false]);
    });

    it("returns null for unknown value shape", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: { attributes: [{ key: "trace.name", value: { mystery: "x" } }] },
            scopeSpans: [makeScopeSpan()],
          },
        ],
      });
      expect(result[0]?.trace.traceName).toBeNull();
    });
  });

  describe("flattenAttributes", () => {
    it("skips non-object entries", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [
                null,
                "bad",
                42,
                { key: "service.name", value: { stringValue: "ok" } },
              ],
            },
            scopeSpans: [makeScopeSpan()],
          },
        ],
      });
      expect(result[0]?.trace.serviceName).toBe("ok");
    });

    it("skips entries whose key is not a string", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: 42, value: { stringValue: "x" } },
                { key: "service.name", value: { stringValue: "ok" } },
              ],
            },
            scopeSpans: [makeScopeSpan()],
          },
        ],
      });
      expect(result[0]?.trace.serviceName).toBe("ok");
    });
  });

  describe("buildMetadata (nested)", () => {
    it("returns null when no trace.metadata.* keys are present", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [makeStringAttr("service.name", "svc")],
          }),
        ],
      });
      expect(result[0]?.trace.metadata).toBeNull();
    });

    it("nests dotted keys into objects", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [
              makeStringAttr("trace.metadata.openrouter.team", "team-1"),
              makeStringAttr("trace.metadata.openrouter.request_id", "r-1"),
              makeStringAttr("trace.metadata.stage", "prod"),
            ],
          }),
        ],
      });
      expect(result[0]?.trace.metadata).toEqual({
        openrouter: { team: "team-1", request_id: "r-1" },
        stage: "prod",
      });
    });

    it("captures trace.metadata.* from span-level attributes via traceAttrs merge", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [makeStringAttr("service.name", "svc")],
            },
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      makeStringAttr("trace.metadata.openrouter.team", "team-span"),
                      makeStringAttr("trace.metadata.owner", "from-span"),
                    ],
                  }),
                ],
              }),
            ],
          },
        ],
      });
      expect(result[0]?.trace.metadata).toEqual({
        openrouter: { team: "team-span" },
        owner: "from-span",
      });
    });

    it("resource-level trace.metadata.* overrides span-level trace.metadata.*", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [
                makeStringAttr("trace.metadata.openrouter.team", "from-resource"),
              ],
            },
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      makeStringAttr("trace.metadata.openrouter.team", "from-span"),
                    ],
                  }),
                ],
              }),
            ],
          },
        ],
      });
      expect(result[0]?.trace.metadata).toEqual({
        openrouter: { team: "from-resource" },
      });
    });

    it("promotes trace.metadata into a column for known keys (entityId, apiKeyName, etc.)", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [
              makeStringAttr("trace.metadata.openrouter.entity_id", "ent-1"),
              makeStringAttr("trace.metadata.openrouter.api_key_name", "k-1"),
              makeStringAttr("trace.metadata.openrouter.provider_name", "p1"),
              makeStringAttr("trace.metadata.openrouter.provider_slug", "p-1"),
              makeStringAttr("trace.metadata.environment", "staging"),
              makeStringAttr("trace.metadata.source", "web"),
              makeDoubleAttr("trace.metadata.openrouter.input_unit_price", 0.0001),
              makeDoubleAttr("trace.metadata.openrouter.output_unit_price", 0.0002),
            ],
          }),
        ],
      });
      const t = result[0]?.trace;
      expect(t?.entityId).toBe("ent-1");
      expect(t?.apiKeyName).toBe("k-1");
      expect(t?.providerName).toBe("p1");
      expect(t?.providerSlug).toBe("p-1");
      expect(t?.environment).toBe("staging");
      expect(t?.source).toBe("web");
      expect(t?.inputUnitPrice).toBe(0.0001);
      expect(t?.outputUnitPrice).toBe(0.0002);
    });
  });

  describe("parseUnixNano", () => {
    it("returns null for undefined", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({ spans: [{ spanId: "s", traceId: "otel-1" }] }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.startTime).toBeNull();
      expect(result[0]?.generations[0]?.durationMs).toBeNull();
    });

    it("returns null for non-numeric nano strings", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [makeSpan({ startTimeUnixNano: "abc", endTimeUnixNano: "1700000001000000000" })],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.startTime).toBeNull();
      expect(result[0]?.generations[0]?.durationMs).toBeNull();
    });

    it("computes durationMs from start and end", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    startTimeUnixNano: "1700000000000000000",
                    endTimeUnixNano: "1700000002500000000",
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.durationMs).toBe(2500);
    });
  });

  describe("tryParseJson", () => {
    it("parses a valid JSON string", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.prompt", value: { stringValue: '{"role":"user"}' } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.prompt).toEqual({ role: "user" });
    });

    it("JSON.stringifies an invalid JSON string", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.completion", value: { stringValue: "not json {{" } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.completion).toBe('"not json {{"');
    });

    it("passes through non-string values", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.prompt", value: { arrayValue: { values: [{ stringValue: "x" }] } } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.prompt).toEqual(["x"]);
    });
  });

  describe("invalid unicode sanitization", () => {
    it("replaces NUL escapes materialized by inner JSON parsing", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      {
                        key: "gen_ai.prompt",
                        value: {
                          stringValue: '{"content":"29.8.2\\n \\u0000tail"}',
                        },
                      },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.prompt).toEqual({
        content: "29.8.2\n \uFFFDtail",
      });
    });

    it("replaces lone surrogates materialized by inner JSON parsing", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      {
                        key: "gen_ai.prompt",
                        value: { stringValue: '{"content":"a\\ud800b"}' },
                      },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.prompt).toEqual({
        content: "a\uFFFDb",
      });
    });

    it("sanitizes actual NUL characters in an unparseable string fallback", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      {
                        key: "gen_ai.completion",
                        value: { stringValue: "bad\u0000json" },
                      },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.completion).toBe('"bad\uFFFDjson"');
    });

    it("sanitizes string attributes used as metadata and tags", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [
              makeStringAttr("trace.metadata.custom", "x\u0000y"),
              makeStringAttr("trace.tags", '["a\\u0000b"]'),
            ],
          }),
        ],
      });
      expect(result[0]?.trace.metadata).toEqual({ custom: "x\uFFFDy" });
      expect(result[0]?.trace.tags).toEqual(["a\uFFFDb"]);
    });
  });

  describe("coerceNumber", () => {
    it("passes through numbers", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [makeSpan({ attributes: [makeIntAttr("gen_ai.request.top_p", 1)] })],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.topP).toBe(1);
    });

    it("coerces numeric strings", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.request.top_p", value: { stringValue: "0.95" } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.topP).toBe(0.95);
    });

    it("returns null for non-numeric strings", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.request.top_p", value: { stringValue: "nope" } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.topP).toBeNull();
    });

    it("returns null for null/undefined", () => {
      const result = parseOtelPayload({
        resourceSpans: [makeResourceSpan()],
      });
      expect(result[0]?.generations[0]?.topP).toBeNull();
    });
  });

  describe("openrouterTraceId fallback", () => {
    it("uses openrouter.trace.id when present", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [makeStringAttr("openrouter.trace.id", "explicit")],
            scopeSpans: [makeScopeSpan({ spans: [makeSpan({ traceId: "otel-1" })] })],
          }),
        ],
      });
      expect(result[0]?.trace.openrouterTraceId).toBe("explicit");
    });

    it("falls back to first span's traceId when no openrouter.trace.id", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [makeScopeSpan({ spans: [makeSpan({ traceId: "otel-fallback" })] })],
          }),
        ],
      });
      expect(result[0]?.trace.openrouterTraceId).toBe("otel-fallback");
    });

    it("skips a resourceSpan with no openrouter.trace.id and no usable span traceId (no useful identifier)", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [makeScopeSpan({ spans: [makeSpan({ traceId: "" })] })],
          }),
        ],
      });
      expect(result).toEqual([]);
    });

    it("ignores empty openrouter.trace.id", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [makeStringAttr("openrouter.trace.id", "")],
            scopeSpans: [makeScopeSpan({ spans: [makeSpan({ traceId: "otel-1" })] })],
          }),
        ],
      });
      expect(result[0]?.trace.openrouterTraceId).toBe("otel-1");
    });
  });

  describe("attribute merging (first span + resource)", () => {
    it("lets resource attributes override first span attributes", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [makeStringAttr("openrouter.trace.id", "from-resource")],
            },
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [makeStringAttr("openrouter.trace.id", "from-span")],
                  }),
                ],
              }),
            ],
          },
        ],
      });
      expect(result[0]?.trace.openrouterTraceId).toBe("from-resource");
    });

    it("uses first span's attrs as base when no conflict", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [makeStringAttr("service.name", "from-resource")],
            },
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [makeStringAttr("gen_ai.system", "from-span")],
                  }),
                ],
              }),
            ],
          },
        ],
      });
      expect(result[0]?.trace.serviceName).toBe("from-resource");
      expect(result[0]?.generations[0]?.system).toBe("from-span");
    });
  });

  describe("generation fields", () => {
    it("maps spanId, name, kind, statusCode from span structure", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    spanId: "s-1",
                    name: "openrouter.chat.completion",
                    kind: 3,
                    statusCode: 2,
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      const g = result[0]?.generations[0];
      expect(g?.spanId).toBe("s-1");
      expect(g?.name).toBe("openrouter.chat.completion");
      expect(g?.kind).toBe(3);
      expect(g?.statusCode).toBe(2);
    });

    it("skips a span with no spanId and reports no generations", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [makeStringAttr("openrouter.trace.id", "or-t1")],
            scopeSpans: [makeScopeSpan({ spans: [{ traceId: "t1" }] })],
          }),
        ],
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.trace.openrouterTraceId).toBe("or-t1");
      expect(result[0]?.generations).toEqual([]);
    });

    it("keeps a sibling span when another span in the same scopeSpan has no spanId", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  { traceId: "t1" },
                  makeSpan({ spanId: "kept" }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations.map((g) => g.spanId)).toEqual(["kept"]);
    });

    it("returns null for kind when it is not a number", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [{ spanId: "s", traceId: "otel-1", kind: "weird" }],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.kind).toBeNull();
    });

    it("returns null for statusCode when status.code is not a number", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  { spanId: "s", traceId: "otel-1", status: { code: "x" } },
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.statusCode).toBeNull();
    });

    it("maps all gen_ai request/response fields", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      makeStringAttr("gen_ai.operation.name", "text_completion"),
                      makeStringAttr("gen_ai.system", "openrouter"),
                      makeStringAttr("gen_ai.provider.name", "anthropic"),
                      makeStringAttr("gen_ai.request.model", "claude-3"),
                      makeStringAttr("gen_ai.response.model", "claude-3.5"),
                      makeStringAttr("gen_ai.response.id", "resp-1"),
                      makeStringAttr("gen_ai.response.finish_reason", "end_turn"),
                      makeStringAttr(
                        "gen_ai.response.finish_reasons",
                        '["end_turn","length"]',
                      ),
                      makeDoubleAttr("gen_ai.request.temperature", 0.5),
                      makeIntAttr("gen_ai.request.max_tokens", 2048),
                      makeDoubleAttr("gen_ai.request.top_p", 0.9),
                      makeDoubleAttr("gen_ai.request.frequency_penalty", 0.1),
                      makeDoubleAttr("gen_ai.request.presence_penalty", 0.2),
                      makeIntAttr("gen_ai.usage.input_tokens", 100),
                      makeIntAttr("gen_ai.usage.output_tokens", 200),
                      makeIntAttr("gen_ai.usage.total_tokens", 300),
                      makeIntAttr("gen_ai.usage.input_tokens.cached", 50),
                      makeIntAttr("gen_ai.usage.output_tokens.reasoning", 25),
                      makeDoubleAttr("gen_ai.usage.input_cost", 0.001),
                      makeDoubleAttr("gen_ai.usage.output_cost", 0.002),
                      makeDoubleAttr("gen_ai.usage.total_cost", 0.003),
                      makeStringAttr("span.type", "llm"),
                      makeStringAttr("span.level", "DEFAULT"),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      const g = result[0]?.generations[0];
      expect(g?.operationName).toBe("text_completion");
      expect(g?.system).toBe("openrouter");
      expect(g?.providerName).toBe("anthropic");
      expect(g?.requestModel).toBe("claude-3");
      expect(g?.responseModel).toBe("claude-3.5");
      expect(g?.responseId).toBe("resp-1");
      expect(g?.finishReason).toBe("end_turn");
      expect(g?.finishReasons).toEqual(["end_turn", "length"]);
      expect(g?.temperature).toBe(0.5);
      expect(g?.maxTokens).toBe(2048);
      expect(g?.topP).toBe(0.9);
      expect(g?.frequencyPenalty).toBe(0.1);
      expect(g?.presencePenalty).toBe(0.2);
      expect(g?.inputTokens).toBe(100);
      expect(g?.outputTokens).toBe(200);
      expect(g?.totalTokens).toBe(300);
      expect(g?.cachedTokens).toBe(50);
      expect(g?.reasoningTokens).toBe(25);
      expect(g?.inputCost).toBe(0.001);
      expect(g?.outputCost).toBe(0.002);
      expect(g?.totalCost).toBe(0.003);
      expect(g?.spanType).toBe("llm");
      expect(g?.spanLevel).toBe("DEFAULT");
    });

    it("sets maxTokens to null when coerceNumber returns NaN (string 'NaN')", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.request.max_tokens", value: { stringValue: "NaN" } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.maxTokens).toBeNull();
    });

    it("keeps finishReasons as-is when not a string", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      {
                        key: "gen_ai.response.finish_reasons",
                        value: { arrayValue: { values: [{ stringValue: "stop" }] } },
                      },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.finishReasons).toEqual(["stop"]);
    });
  });

  describe("prompt/completion preference", () => {
    it("prefers gen_ai.prompt over trace.input", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.prompt", value: { stringValue: '"from-genai"' } },
                      { key: "trace.input", value: { stringValue: '"from-trace"' } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.prompt).toBe("from-genai");
    });

    it("falls back to trace.input when no gen_ai.prompt", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "trace.input", value: { stringValue: '"from-trace"' } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.prompt).toBe("from-trace");
    });

    it("prefers gen_ai.completion over trace.output", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      { key: "gen_ai.completion", value: { stringValue: '"from-genai"' } },
                      { key: "trace.output", value: { stringValue: '"from-trace"' } },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.generations[0]?.completion).toBe("from-genai");
    });
  });

  describe("trace-level fields", () => {
    it("maps session.id, user.id, trace.name, service.name, trace.tags", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [
                makeStringAttr("openrouter.trace.id", "t1"),
                makeStringAttr("service.name", "svc"),
                makeStringAttr("trace.name", "my-trace"),
                makeStringAttr("session.id", "sess-1"),
                makeStringAttr("user.id", "user-1"),
                makeStringAttr("trace.tags", '["a","b"]'),
              ],
            },
            scopeSpans: [makeScopeSpan()],
          },
        ],
      });
      const t = result[0]?.trace;
      expect(t?.serviceName).toBe("svc");
      expect(t?.traceName).toBe("my-trace");
      expect(t?.sessionId).toBe("sess-1");
      expect(t?.userId).toBe("user-1");
      expect(t?.tags).toEqual(["a", "b"]);
    });

    it("keeps trace.tags as-is when not a string", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          {
            resource: {
              attributes: [
                makeArrayAttr("trace.tags", [{ stringValue: "x" }, { intValue: 2 }]),
              ],
            },
            scopeSpans: [makeScopeSpan()],
          },
        ],
      });
      expect(result[0]?.trace.tags).toEqual(["x", 2]);
    });
  });

  describe("metadata", () => {
    it("keeps only non-extracted trace.metadata keys", () => {
      const result = parseOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({
                    attributes: [
                      makeStringAttr("trace.metadata.openrouter.entity_id", "e1"),
                      makeStringAttr("trace.metadata.openrouter.api_key_name", "key1"),
                      makeStringAttr("trace.metadata.openrouter.provider_name", "p1"),
                      makeStringAttr("trace.metadata.openrouter.provider_slug", "openai"),
                      makeStringAttr("trace.metadata.environment", "prod"),
                      makeStringAttr("trace.metadata.source", "webhook"),
                      makeStringAttr("trace.metadata.custom", "kept"),
                      makeDoubleAttr("trace.metadata.openrouter.input_unit_price", 0.5),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      expect(result[0]?.trace.metadata).toEqual({
        custom: "kept",
        openrouter: { input_unit_price: 0.5 },
      });
    });
  });
});
