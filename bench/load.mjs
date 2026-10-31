// Baseline load generator: fires OTel webhooks at the ingest endpoint at a
// fixed rate for a fixed duration. Uses only fetch + setTimeout so it runs
// identically under node and bun (fair comparison of servers, not clients).
//
// Usage: node bench/load.mjs <url> <secret> <rps> <durationSec> <concurrency>
const [, , url, secret, rpsArg = "50", durArg = "30", concArg = "16"] = process.argv;
const RPS = Number(rpsArg);
const DURATION = Number(durArg);
const CONCURRENCY = Number(concArg);
const HEADER = process.env.WEBHOOK_SECRET_HEADER || "X-Webhook-Signature";

let spanCounter = 0;
function makePayload(n) {
  const spans = [];
  for (let s = 0; s < 20; s++) {
    spans.push({
      spanId: `span-${n}-${s}`,
      traceId: `otel-${n}`,
      name: "openrouter.chat",
      kind: 1,
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000001000000000",
      attributes: [
        { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
        { key: "gen_ai.system", value: { stringValue: "openrouter" } },
        { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
        { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
        { key: "gen_ai.response.model", value: { stringValue: "gpt-4o-2024-08-06" } },
        { key: "gen_ai.response.finish_reason", value: { stringValue: "stop" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: "50" } },
        { key: "gen_ai.usage.total_tokens", value: { intValue: "150" } },
        { key: "gen_ai.prompt", value: { stringValue: "user".repeat(600) } },
        { key: "gen_ai.completion", value: { stringValue: "assistant".repeat(400) } },
      ],
    });
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "openrouter.trace.id", value: { stringValue: `or-${n}` } },
            { key: "service.name", value: { stringValue: "bench-service" } },
          ],
        },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

let ok = 0, fail = 0, bytes = 0;
const deadline = Date.now() + DURATION * 1000;
const intervalMs = 1000 / RPS;
const inFlight = new Set();
let inflightPeak = 0;

async function send(n) {
  const body = JSON.stringify(makePayload(n));
  bytes += body.length;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [HEADER]: secret },
      body,
    });
    if (res.ok) ok++;
    else { fail++; await res.text(); }
  } catch {
    fail++;
  }
}

function fire(n) {
  const p = send(n).finally(() => inFlight.delete(p));
  inFlight.add(p);
  if (inFlight.size > inflightPeak) inflightPeak = inFlight.size;
}

const start = Date.now();
let next = start;
while (Date.now() < deadline) {
  fire(spanCounter++);
  next += intervalMs;
  const wait = next - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  else if (inFlight.size > CONCURRENCY * 2) {
    // server can't keep up; wait for the backlog to drain a bit
    await Promise.race(inFlight);
  }
}
await Promise.all(inFlight);
const elapsed = (Date.now() - start) / 1000;

console.log(JSON.stringify({
  ok, fail,
  elapsedSec: Number(elapsed.toFixed(2)),
  rps: Number((ok / elapsed).toFixed(1)),
  attemptedRps: Number((spanCounter / elapsed).toFixed(1)),
  mbPerSec: Number((bytes / elapsed / 1e6).toFixed(2)),
  inflightPeak,
}));
