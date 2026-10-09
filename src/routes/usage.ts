import { Router } from "express";
import { sql, type Kysely } from "kysely";
import type { Database } from "../types.js";

interface DailyRow {
  day: string;
  model: string;
  calls: string;
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  reasoning_tokens: string;
  total_tokens: string;
  total_cost: string;
  avg_duration_ms: number | null;
  p50_duration_ms: string | null;
  p95_duration_ms: string | null;
  status_counts: Record<string, number> | null;
  finish_reason_counts: Record<string, number> | null;
  provider_counts: Record<string, number> | null;
  response_model_counts: Record<string, number> | null;
  prompt_chars: string | null;
  completion_chars: string | null;
}

interface HeatmapRow {
  dow: number;
  hour: number;
  calls: string;
}

interface TopCallRow {
  model: string;
  provider: string;
  total_tokens: string;
  duration_ms: string;
  total_cost: string;
  start_time: string;
}

export interface ModelAgg {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  avgDurationMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  promptChars: number;
  completionChars: number;
  statusCounts: Record<string, number>;
  finishCounts: Record<string, number>;
  providerCounts: Record<string, number>;
  responseCounts: Record<string, number>;
}

interface ModelAggInternal extends ModelAgg {
  durationWeight: number;
  p50Weight: number;
  p95Weight: number;
  weightedDuration: number;
  weightedP50: number;
  weightedP95: number;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatNumber(value: string | null): string {
  if (value == null) return "0";
  return Number(value).toLocaleString("en-US");
}

export function formatCost(value: string | null): string {
  if (value == null) return "$0.0000";
  return `$${Number(value).toFixed(4)}`;
}

export function clampDays(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n =
    typeof raw === "string" && raw !== ""
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

export function deltaPct(
  current: number,
  previous: number | undefined,
): string | null {
  if (previous === undefined || previous === 0) return null;
  const d = ((current - previous) / previous) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

export function pct(part: number, total: number): string {
  if (total <= 0) return "—";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function mergeCounts(
  target: Record<string, number>,
  source: Record<string, number> | null,
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + Number(value);
  }
}

export function aggregateByModel(rows: DailyRow[]): ModelAgg[] {
  const byModel = new Map<string, ModelAggInternal>();
  for (const row of rows) {
    const calls = Number(row.calls);
    let agg = byModel.get(row.model);
    if (!agg) {
      agg = {
        model: row.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cost: 0,
        avgDurationMs: null,
        p50Ms: null,
        p95Ms: null,
        promptChars: 0,
        completionChars: 0,
        statusCounts: {},
        finishCounts: {},
        providerCounts: {},
        responseCounts: {},
        durationWeight: 0,
        p50Weight: 0,
        p95Weight: 0,
        weightedDuration: 0,
        weightedP50: 0,
        weightedP95: 0,
      };
      byModel.set(row.model, agg);
    }
    agg.calls += calls;
    agg.inputTokens += Number(row.input_tokens);
    agg.outputTokens += Number(row.output_tokens);
    agg.cachedTokens += Number(row.cached_tokens);
    agg.reasoningTokens += Number(row.reasoning_tokens);
    agg.totalTokens += Number(row.total_tokens);
    agg.cost += Number(row.total_cost);
    agg.promptChars += Number(row.prompt_chars ?? 0);
    agg.completionChars += Number(row.completion_chars ?? 0);

    if (row.avg_duration_ms != null && calls > 0) {
      agg.weightedDuration += row.avg_duration_ms * calls;
      agg.durationWeight += calls;
    }
    if (row.p50_duration_ms != null && calls > 0) {
      agg.weightedP50 += Number(row.p50_duration_ms) * calls;
      agg.p50Weight += calls;
    }
    if (row.p95_duration_ms != null && calls > 0) {
      agg.weightedP95 += Number(row.p95_duration_ms) * calls;
      agg.p95Weight += calls;
    }

    mergeCounts(agg.statusCounts, row.status_counts);
    mergeCounts(agg.finishCounts, row.finish_reason_counts);
    mergeCounts(agg.providerCounts, row.provider_counts);
    mergeCounts(agg.responseCounts, row.response_model_counts);
  }

  return [...byModel.values()]
    .map((agg) => ({
      ...agg,
      avgDurationMs:
        agg.durationWeight > 0
          ? Math.round(agg.weightedDuration / agg.durationWeight)
          : null,
      p50Ms:
        agg.p50Weight > 0 ? Math.round(agg.weightedP50 / agg.p50Weight) : null,
      p95Ms:
        agg.p95Weight > 0 ? Math.round(agg.weightedP95 / agg.p95Weight) : null,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export function renderTrendChart(
  points: { label: string; value: number }[],
  opts: { barWidth?: number; height?: number } = {},
): string {
  const barWidth = opts.barWidth ?? 14;
  const height = opts.height ?? 120;
  const gap = 4;
  const chartHeight = height - 8;
  const width = Math.max(points.length * (barWidth + gap), barWidth);
  const max = points.reduce((acc, p) => Math.max(acc, p.value), 0);
  const bars = points
    .map((p, i) => {
      const h = max > 0 ? Math.round((p.value / max) * chartHeight) : 0;
      const x = i * (barWidth + gap);
      const y = chartHeight - h;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="1" fill="#2b6cb0"><title>${escapeHtml(p.label)}: ${formatNumber(String(p.value))}</title></rect>`;
    })
    .join("");
  return `<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${bars}</svg>`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function renderHeatmap(
  cells: { dow: number; hour: number; value: number }[],
  maxValue: number,
): string {
  const size = 12;
  const gap = 2;
  const width = 7 * (size + gap);
  const height = 24 * (size + gap);
  const byKey = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c.value]));
  let rects = "";
  for (let hour = 0; hour < 24; hour++) {
    for (let dow = 1; dow <= 7; dow++) {
      const value = byKey.get(`${dow}:${hour}`) ?? 0;
      const alpha =
        value === 0 || maxValue <= 0
          ? 0.04
          : 0.15 + 0.85 * (value / maxValue);
      const x = (dow - 1) * (size + gap);
      const y = hour * (size + gap);
      rects += `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="1" fill="rgba(43,108,176,${alpha.toFixed(2)})"><title>${DAY_NAMES[dow - 1]} ${String(hour).padStart(2, "0")}:00 UTC — ${formatNumber(String(value))} calls</title></rect>`;
    }
  }
  return `<svg class="heatmap" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${rects}</svg>`;
}

const SEGMENT_COLORS = [
  "#2b6cb0",
  "#2f855a",
  "#b7791f",
  "#c53030",
  "#6b46c1",
  "#4a5568",
  "#dd6b20",
];

export function renderStackedBar(
  segments: { label: string; value: number }[],
): string {
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  if (total <= 0) return `<div class="bar"></div>`;
  const parts = segments
    .map((s, i) => {
      const width = (s.value / total) * 100;
      return `<span class="seg" style="width:${width.toFixed(2)}%;background:${SEGMENT_COLORS[i % SEGMENT_COLORS.length]}" title="${escapeHtml(s.label)}: ${formatNumber(String(s.value))}"></span>`;
    })
    .join("");
  return `<div class="bar">${parts}</div>`;
}

function renderStackedLegend(
  segments: { label: string; value: number }[],
): string {
  return segments
    .map(
      (s, i) =>
        `<span class="legend-item"><span class="swatch" style="background:${SEGMENT_COLORS[i % SEGMENT_COLORS.length]}"></span>${escapeHtml(s.label)} ${formatNumber(String(s.value))}</span>`,
    )
    .join(" ");
}

function card(title: string, value: string, sub?: string | null): string {
  const subHtml = sub ? `<div class="card-sub">${escapeHtml(sub)}</div>` : "";
  return `<div class="card"><div class="card-title">${escapeHtml(title)}</div><div class="card-value">${value}</div>${subHtml}</div>`;
}

function renderSummaryCards(models: ModelAgg[], prev: { calls: number; cost: number } | undefined): string {
  const totals = models.reduce(
    (acc, m) => {
      acc.calls += m.calls;
      acc.cost += m.cost;
      acc.inputTokens += m.inputTokens;
      acc.cachedTokens += m.cachedTokens;
      acc.totalTokens += m.totalTokens;
      return acc;
    },
    { calls: 0, cost: 0, inputTokens: 0, cachedTokens: 0, totalTokens: 0 },
  );
  const cards = [
    card("Total calls", formatNumber(String(totals.calls)), deltaPct(totals.calls, prev?.calls)),
    card("Total cost", formatCost(String(totals.cost)), deltaPct(totals.cost, prev?.cost)),
    card("Cache hit rate", pct(totals.cachedTokens, totals.inputTokens)),
    card("Avg cost / call", formatCost(String(totals.calls > 0 ? totals.cost / totals.calls : 0))),
    card("Total tokens", formatNumber(String(totals.totalTokens))),
    card("Avg tokens / call", formatNumber(String(totals.calls > 0 ? Math.round(totals.totalTokens / totals.calls) : 0))),
  ];
  return `<div class="cards">${cards.join("")}</div>`;
}

function renderTrendSection(
  daily: { day: string; calls: number; cost: number }[],
): string {
  if (daily.length === 0) return "";
  const labels = daily.map((d) => d.day);
  const costChart = renderTrendChart(
    daily.map((d, i) => ({ label: labels[i] ?? "", value: Math.round(d.cost * 10000) / 10000 })),
  );
  const callsChart = renderTrendChart(
    daily.map((d, i) => ({ label: labels[i] ?? "", value: d.calls })),
  );
  const last = daily[daily.length - 1];
  const prev = daily[daily.length - 2];
  const costDelta = deltaPct(last?.cost ?? 0, prev?.cost);
  const callsDelta = deltaPct(last?.calls ?? 0, prev?.calls);
  return `<section>
    <h2>Daily trend</h2>
    <div class="charts">
      <div><h3>Cost</h3>${costChart}${costDelta ? `<div class="chart-sub">latest day vs prev: ${escapeHtml(costDelta)}</div>` : ""}</div>
      <div><h3>Calls</h3>${callsChart}${callsDelta ? `<div class="chart-sub">latest day vs prev: ${escapeHtml(callsDelta)}</div>` : ""}</div>
    </div>
  </section>`;
}

function renderHeatmapSection(cells: HeatmapRow[]): string {
  const parsed = cells.map((c) => ({
    dow: Number(c.dow),
    hour: Number(c.hour),
    value: Number(c.calls),
  }));
  const maxValue = parsed.reduce((acc, c) => Math.max(acc, c.value), 0);
  return `<section>
    <h2>Activity by hour (UTC)</h2>
    <div class="heatmap-wrap">${renderHeatmap(parsed, maxValue)}</div>
  </section>`;
}

function renderModelTable(models: ModelAgg[]): string {
  const rows = models
    .map((m) => {
      const errors = m.statusCounts["2"] ?? 0;
      return `<tr>
        <td>${escapeHtml(m.model)}</td>
        <td class="num">${formatNumber(String(m.calls))}</td>
        <td class="num">${formatNumber(String(m.inputTokens))}</td>
        <td class="num">${formatNumber(String(m.outputTokens))}</td>
        <td class="num">${formatNumber(String(m.cachedTokens))}</td>
        <td class="num">${formatNumber(String(m.reasoningTokens))}</td>
        <td class="num">${formatNumber(String(m.totalTokens))}</td>
        <td class="num">${formatCost(String(m.cost))}</td>
        <td class="num">${formatCost(String(m.calls > 0 ? m.cost / m.calls : 0))}</td>
        <td class="num">${formatCost(String(m.totalTokens > 0 ? (m.cost / m.totalTokens) * 1_000_000 : 0))}</td>
        <td class="num">${pct(m.cachedTokens, m.inputTokens)}</td>
        <td class="num">${m.p50Ms == null ? "—" : `${formatNumber(String(m.p50Ms))} ms`}</td>
        <td class="num">${m.p95Ms == null ? "—" : `${formatNumber(String(m.p95Ms))} ms`}</td>
        <td class="num">${pct(errors, m.calls)}</td>
        <td class="num">${formatNumber(String(m.calls > 0 ? Math.round(m.promptChars / m.calls) : 0))}</td>
        <td class="num">${formatNumber(String(m.calls > 0 ? Math.round(m.completionChars / m.calls) : 0))}</td>
      </tr>`;
    })
    .join("");
  return `<section>
    <h2>Models</h2>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Model</th>
        <th class="num">Calls</th>
        <th class="num">Input</th>
        <th class="num">Output</th>
        <th class="num">Cached</th>
        <th class="num">Reasoning</th>
        <th class="num">Total</th>
        <th class="num">Cost</th>
        <th class="num">$/call</th>
        <th class="num">$/1M tok</th>
        <th class="num">Cache hit</th>
        <th class="num">p50</th>
        <th class="num">p95</th>
        <th class="num">Errors</th>
        <th class="num">Prompt chars</th>
        <th class="num">Completion chars</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function renderOutcomeSection(models: ModelAgg[]): string {
  const rows = models
    .filter(
      (m) =>
        Object.keys(m.finishCounts).length > 0 ||
        Object.keys(m.statusCounts).length > 0,
    )
    .map((m) => {
      const finishSegments = Object.entries(m.finishCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([label, value]) => ({ label, value }));
      const errors = Object.entries(m.statusCounts)
        .filter(([code]) => code !== "0" && code !== "1")
        .reduce((acc, [, value]) => acc + value, 0);
      return `<tr>
        <td>${escapeHtml(m.model)}</td>
        <td>${renderStackedBar(finishSegments)}<div class="legend">${renderStackedLegend(finishSegments)}</div></td>
        <td class="num">${formatNumber(String(errors))} (${pct(errors, m.calls)})</td>
      </tr>`;
    })
    .join("");
  if (!rows) return "";
  return `<section>
    <h2>Outcomes</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Model</th><th>Finish reasons</th><th class="num">Errors</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function renderDriftSection(models: ModelAgg[]): string {
  const rows = models
    .flatMap((m) =>
      Object.entries(m.responseCounts)
        .filter(([response]) => response !== "(unknown)" && response !== m.model)
        .map(([response, count]) => ({ model: m.model, response, count })),
    )
    .sort((a, b) => b.count - a.count);
  if (rows.length === 0) return "";
  return `<section>
    <h2>Model drift (requested vs served)</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Requested</th><th>Served</th><th class="num">Calls</th></tr></thead>
      <tbody>${rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.model)}</td><td>${escapeHtml(r.response)}</td><td class="num">${formatNumber(String(r.count))}</td></tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </section>`;
}

function renderTopCallsSection(rows: TopCallRow[]): string {
  if (rows.length === 0) return "";
  return `<section>
    <h2>Most expensive calls</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Time (UTC)</th><th>Model</th><th>Provider</th><th class="num">Tokens</th><th class="num">Duration</th><th class="num">Cost</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr>
            <td>${escapeHtml(r.start_time)}</td>
            <td>${escapeHtml(r.model)}</td>
            <td>${escapeHtml(r.provider)}</td>
            <td class="num">${formatNumber(r.total_tokens)}</td>
            <td class="num">${formatNumber(r.duration_ms)} ms</td>
            <td class="num">${formatCost(r.total_cost)}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </section>`;
}

function renderUsagePage(
  models: ModelAgg[],
  daily: { day: string; calls: number; cost: number }[],
  heatmap: HeatmapRow[],
  topCalls: TopCallRow[],
  days: number,
): string {
  const prev = daily[daily.length - 2];
  const prevTotals = prev ? { calls: prev.calls, cost: prev.cost } : undefined;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenRouter Usage — last ${days} days</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin: 1.6rem 0 0.6rem; }
  h3 { font-size: 0.9rem; margin: 0 0 0.3rem; color: #555; }
  .summary { margin: 0.5rem 0 1rem; color: #555; }
  .cards { display: flex; flex-wrap: wrap; gap: 0.8rem; margin: 1rem 0; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 0.6rem 0.9rem; min-width: 8.5rem; }
  .card-title { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: 0.03em; }
  .card-value { font-size: 1.3rem; font-weight: 600; }
  .card-sub { font-size: 0.75rem; color: #666; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.7rem; text-align: left; font-size: 0.9rem; }
  th { background: #f4f4f4; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) { background: #fafafa; }
  .table-wrap { overflow-x: auto; }
  .charts { display: flex; flex-wrap: wrap; gap: 2rem; align-items: flex-end; }
  .chart-sub { font-size: 0.75rem; color: #666; }
  .heatmap-wrap { overflow-x: auto; }
  .bar { display: flex; width: 100%; min-width: 12rem; height: 0.9rem; border-radius: 3px; overflow: hidden; background: #eee; }
  .seg { display: inline-block; height: 100%; }
  .legend { margin-top: 0.2rem; font-size: 0.75rem; color: #555; }
  .legend-item { margin-right: 0.6rem; white-space: nowrap; }
  .swatch { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 2px; margin-right: 0.25rem; vertical-align: middle; }
  .window-note { font-size: 0.8rem; color: #666; }
</style>
</head>
<body>
  <h1>OpenRouter Usage — last ${days} days</h1>
  <div class="window-note">Window: ?days=1..90 (defaults to trace retention)</div>
  ${renderSummaryCards(models, prevTotals)}
  ${renderTrendSection(daily)}
  ${renderHeatmapSection(heatmap)}
  ${renderModelTable(models)}
  ${renderOutcomeSection(models)}
  ${renderDriftSection(models)}
  ${renderTopCallsSection(topCalls)}
</body>
</html>`;
}

export function usageRouter(db: Kysely<Database>, retentionDays: number) {
  const router = Router();

  router.get("/usage", async (req, res) => {
    const days = clampDays(req.query.days, retentionDays);
    try {
      const daily = await sql<DailyRow>`
        SELECT
          day::text AS day,
          model,
          calls::text AS calls,
          input_tokens::text AS input_tokens,
          output_tokens::text AS output_tokens,
          cached_tokens::text AS cached_tokens,
          reasoning_tokens::text AS reasoning_tokens,
          total_tokens::text AS total_tokens,
          total_cost::text AS total_cost,
          avg_duration_ms,
          p50_duration_ms::text AS p50_duration_ms,
          p95_duration_ms::text AS p95_duration_ms,
          status_counts,
          finish_reason_counts,
          provider_counts,
          response_model_counts,
          prompt_chars::text AS prompt_chars,
          completion_chars::text AS completion_chars
        FROM usage_daily
        WHERE day >= (now() - ${days} * interval '1 day')::date
        ORDER BY day ASC
      `.execute(db);

      const heatmap = await sql<HeatmapRow>`
        SELECT
          extract(isodow FROM hour)::int AS dow,
          extract(hour FROM hour)::int AS hour,
          SUM(calls)::text AS calls
        FROM usage_hourly
        WHERE hour >= date_trunc('day', now() - ${days} * interval '1 day')
        GROUP BY 1, 2
      `.execute(db);

      const topCalls = await sql<TopCallRow>`
        SELECT
          COALESCE(request_model, '(unknown)') AS model,
          COALESCE(provider_name, '(unknown)') AS provider,
          COALESCE(total_tokens, 0)::text AS total_tokens,
          COALESCE(duration_ms, 0)::text AS duration_ms,
          total_cost::text AS total_cost,
          to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS start_time
        FROM llm_generations
        WHERE start_time >= now() - ${days} * interval '1 day'
          AND total_cost IS NOT NULL
        ORDER BY total_cost DESC
        LIMIT 10
      `.execute(db);

      const models = aggregateByModel(daily.rows);

      const byDay = new Map<string, { calls: number; cost: number }>();
      for (const row of daily.rows) {
        const entry = byDay.get(row.day) ?? { calls: 0, cost: 0 };
        entry.calls += Number(row.calls);
        entry.cost += Number(row.total_cost);
        byDay.set(row.day, entry);
      }
      const dayTotals = [...byDay.entries()].map(([day, v]) => ({
        day,
        calls: v.calls,
        cost: v.cost,
      }));

      res
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'",
        )
        .send(
          renderUsagePage(
            models,
            dayTotals,
            heatmap.rows,
            topCalls.rows,
            days,
          ),
        );
    } catch {
      res
        .status(500)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .send("<h1>Error</h1><p>Failed to load usage data.</p>");
    }
  });

  return router;
}
