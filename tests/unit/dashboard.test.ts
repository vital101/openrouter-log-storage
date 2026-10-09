import { describe, it, expect } from "vitest";
import {
  aggregateByModel,
  clampDays,
  deltaPct,
  formatCost,
  formatNumber,
  pct,
  renderHeatmap,
  renderStackedBar,
  renderTrendChart,
} from "../../src/routes/usage.js";

type DailyRow = Parameters<typeof aggregateByModel>[0][number];

function row(overrides: Partial<DailyRow>): DailyRow {
  return {
    day: "2026-01-01",
    model: "model-a",
    calls: "1",
    input_tokens: "0",
    output_tokens: "0",
    cached_tokens: "0",
    reasoning_tokens: "0",
    total_tokens: "0",
    total_cost: "0",
    avg_duration_ms: null,
    p50_duration_ms: null,
    p95_duration_ms: null,
    status_counts: null,
    finish_reason_counts: null,
    provider_counts: null,
    response_model_counts: null,
    prompt_chars: null,
    completion_chars: null,
    ...overrides,
  };
}

describe("clampDays", () => {
  it("returns the fallback for undefined, empty and non-numeric input", () => {
    expect(clampDays(undefined, 30)).toBe(30);
    expect(clampDays("", 30)).toBe(30);
    expect(clampDays("abc", 30)).toBe(30);
    expect(clampDays(NaN, 30)).toBe(30);
  });

  it("parses numeric strings and numbers", () => {
    expect(clampDays("10", 30)).toBe(10);
    expect(clampDays(7, 30)).toBe(7);
    expect(clampDays("12.9", 30)).toBe(12);
  });

  it("clamps to 1..90", () => {
    expect(clampDays("999", 30)).toBe(90);
    expect(clampDays("0", 30)).toBe(1);
    expect(clampDays("-5", 30)).toBe(1);
  });

  it("handles Express query arrays by taking the first element", () => {
    expect(clampDays(["5", "9"], 30)).toBe(5);
  });
});

describe("deltaPct", () => {
  it("returns null when there is no previous value", () => {
    expect(deltaPct(10, undefined)).toBeNull();
    expect(deltaPct(10, 0)).toBeNull();
  });

  it("formats increases and decreases", () => {
    expect(deltaPct(150, 100)).toBe("+50.0%");
    expect(deltaPct(75, 100)).toBe("-25.0%");
  });
});

describe("pct", () => {
  it("returns an em dash for a zero total", () => {
    expect(pct(1, 0)).toBe("—");
  });

  it("formats one decimal place", () => {
    expect(pct(1, 4)).toBe("25.0%");
  });
});

describe("formatNumber / formatCost", () => {
  it("formats numbers and costs", () => {
    expect(formatNumber("1000")).toBe("1,000");
    expect(formatNumber(null)).toBe("0");
    expect(formatCost("0.1234")).toBe("$0.1234");
    expect(formatCost(null)).toBe("$0.0000");
  });
});

describe("aggregateByModel", () => {
  it("merges rows across days, sums counters and merges jsonb mixes", () => {
    const models = aggregateByModel([
      row({
        day: "2026-01-01",
        calls: "2",
        input_tokens: "100",
        cached_tokens: "40",
        total_tokens: "150",
        total_cost: "0.10",
        avg_duration_ms: 100,
        p50_duration_ms: "80",
        p95_duration_ms: "180",
        prompt_chars: "60",
        completion_chars: "20",
        status_counts: { "1": 1, "2": 1 },
        finish_reason_counts: { stop: 2 },
        provider_counts: { openai: 2 },
        response_model_counts: { "gpt-4o": 2 },
      }),
      row({
        day: "2026-01-02",
        calls: "1",
        input_tokens: "50",
        cached_tokens: "10",
        total_tokens: "75",
        total_cost: "0.05",
        avg_duration_ms: 200,
        p50_duration_ms: "120",
        p95_duration_ms: "220",
        prompt_chars: "30",
        completion_chars: "10",
        status_counts: { "1": 1 },
        finish_reason_counts: { length: 1 },
        provider_counts: { anthropic: 1 },
        response_model_counts: { "claude-3": 1 },
      }),
    ]);

    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m?.calls).toBe(3);
    expect(m?.inputTokens).toBe(150);
    expect(m?.cachedTokens).toBe(50);
    expect(m?.totalTokens).toBe(225);
    expect(m?.cost).toBeCloseTo(0.15);
    expect(m?.statusCounts).toEqual({ "1": 2, "2": 1 });
    expect(m?.finishCounts).toEqual({ stop: 2, length: 1 });
    expect(m?.providerCounts).toEqual({ openai: 2, anthropic: 1 });
    expect(m?.responseCounts).toEqual({ "gpt-4o": 2, "claude-3": 1 });
    expect(m?.promptChars).toBe(90);
    expect(m?.completionChars).toBe(30);
    expect(m?.avgDurationMs).toBe(133);
    expect(m?.p50Ms).toBe(93);
    expect(m?.p95Ms).toBe(193);
  });

  it("sorts models by cost desc", () => {
    const models = aggregateByModel([
      row({ model: "cheap", total_cost: "0.01" }),
      row({ model: "pricey", total_cost: "1.00" }),
    ]);
    expect(models.map((m) => m.model)).toEqual(["pricey", "cheap"]);
  });

  it("leaves latency null when no durations were recorded", () => {
    const models = aggregateByModel([row({})]);
    expect(models[0]?.avgDurationMs).toBeNull();
    expect(models[0]?.p50Ms).toBeNull();
    expect(models[0]?.p95Ms).toBeNull();
  });
});

describe("renderTrendChart", () => {
  it("renders one titled bar per point", () => {
    const svg = renderTrendChart([
      { label: "2026-01-01", value: 10 },
      { label: "2026-01-02", value: 20 },
    ]);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<title>2026-01-01: 10</title>");
    expect(svg).toContain("<title>2026-01-02: 20</title>");
    expect(svg.match(/<rect /g)).toHaveLength(2);
  });

  it("renders an empty svg for no points", () => {
    const svg = renderTrendChart([]);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<rect");
  });
});

describe("renderHeatmap", () => {
  it("renders a 7x24 grid with titles", () => {
    const svg = renderHeatmap([{ dow: 1, hour: 0, value: 5 }], 5);
    expect(svg.match(/<rect /g)).toHaveLength(168);
    expect(svg).toContain("Mon 00:00 UTC — 5 calls");
  });
});

describe("renderStackedBar", () => {
  it("renders segments proportional to values", () => {
    const html = renderStackedBar([
      { label: "stop", value: 3 },
      { label: "length", value: 1 },
    ]);
    expect(html).toContain("width:75.00%");
    expect(html).toContain("width:25.00%");
    expect(html).toContain('title="stop: 3"');
  });

  it("renders an empty bar when there is no data", () => {
    expect(renderStackedBar([])).toBe('<div class="bar"></div>');
  });
});
