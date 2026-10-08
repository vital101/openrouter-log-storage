import { Router } from "express";
import { sql, type Kysely } from "kysely";
import type { Database } from "../types.js";

interface UsageRow {
  day: string;
  model: string;
  calls: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cached_tokens: string | null;
  reasoning_tokens: string | null;
  total_tokens: string | null;
  total_cost: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value: string | null): string {
  if (value == null) return "0";
  return Number(value).toLocaleString("en-US");
}

function formatCost(value: string | null): string {
  if (value == null) return "$0.0000";
  return `$${Number(value).toFixed(4)}`;
}

function renderUsagePage(rows: UsageRow[], summary: { calls: string; cost: string }, retentionDays: number): string {
  const body = rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.day)}</td>
        <td>${escapeHtml(row.model)}</td>
        <td class="num">${formatNumber(row.calls)}</td>
        <td class="num">${formatNumber(row.input_tokens)}</td>
        <td class="num">${formatNumber(row.output_tokens)}</td>
        <td class="num">${formatNumber(row.cached_tokens)}</td>
        <td class="num">${formatNumber(row.reasoning_tokens)}</td>
        <td class="num">${formatNumber(row.total_tokens)}</td>
        <td class="num">${formatCost(row.total_cost)}</td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenRouter Usage — last ${retentionDays} days</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  .summary { margin: 0.5rem 0 1.5rem; color: #555; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.7rem; text-align: left; font-size: 0.9rem; }
  th { background: #f4f4f4; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) { background: #fafafa; }
</style>
</head>
<body>
  <h1>OpenRouter Usage — last ${retentionDays} days</h1>
  <div class="summary">Total calls: <strong>${formatNumber(summary.calls)}</strong> · Total cost: <strong>${formatCost(summary.cost)}</strong></div>
  <table>
    <thead>
      <tr>
        <th>Day</th>
        <th>Model</th>
        <th class="num">Calls</th>
        <th class="num">Input tokens</th>
        <th class="num">Output tokens</th>
        <th class="num">Cached tokens</th>
        <th class="num">Reasoning tokens</th>
        <th class="num">Total tokens</th>
        <th class="num">Cost</th>
      </tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table>
</body>
</html>`;
}

export function usageRouter(db: Kysely<Database>, retentionDays: number) {
  const router = Router();

  router.get("/usage", async (_req, res) => {
    try {
      const rows = await sql<UsageRow>`
        SELECT
          day::text AS day,
          model,
          calls::text AS calls,
          input_tokens::text AS input_tokens,
          output_tokens::text AS output_tokens,
          cached_tokens::text AS cached_tokens,
          reasoning_tokens::text AS reasoning_tokens,
          total_tokens::text AS total_tokens,
          total_cost::text AS total_cost
        FROM usage_daily
        WHERE day >= (now() - ${retentionDays} * interval '1 day')::date
        ORDER BY day DESC, calls DESC
      `.execute(db);

      const data = rows.rows;
      const totalCalls = data.reduce((acc, r) => acc + Number(r.calls), 0);
      const totalCost = data.reduce((acc, r) => acc + Number(r.total_cost ?? 0), 0);

      res
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
        .send(
          renderUsagePage(
            data,
            {
              calls: String(totalCalls),
              cost: totalCost.toFixed(4),
            },
            retentionDays,
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
