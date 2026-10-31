// Benchmark orchestrator. Launches server + worker as child processes,
// samples RSS/CPU, fires load at the server, then reports.
//
// Usage: node bench/measure.mjs <node|bun> <label>
// Env: DATABASE_URL, WEBHOOK_SECRET required (point at a scratch DB!)
import { spawn, execFileSync } from "node:child_process";

const RUNTIME = process.argv[2] || "node";
const LABEL = process.argv[3] || RUNTIME;
const PORT = Number(process.env.BENCH_PORT || 3100);
const RPS = process.env.BENCH_RPS || "50";
const DURATION = process.env.BENCH_DURATION || "30";

// Bun runs TypeScript sources directly; the Node baseline uses the compiled
// dist/ build produced by the last `npm run build` on the pre-migration tree.
const SERVER_ENTRY = RUNTIME === "bun" ? "src/server.ts" : "dist/server.js";
const WORKER_ENTRY = RUNTIME === "bun" ? "src/worker/index.ts" : "dist/worker/index.js";

const launch = (entry) =>
  RUNTIME === "bun"
    ? spawn("bun", [entry], { stdio: "pipe", env: { ...process.env, PORT: String(PORT) } })
    : spawn("node", [entry], { stdio: "pipe", env: { ...process.env, PORT: String(PORT) } });

// ps sampler: rss KB + cpu % for a pid. `ps -o rss=,pcpu=` suppresses headers.
function sample(pid) {
  try {
    const out = execFileSync("ps", ["-o", "rss=,pcpu=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const parts = out.split(/\s+/);
    const rss = Number(parts[0]) || 0;
    const cpu = Number(parts[1]) || 0;
    return { rss, cpu };
  } catch {
    return { rss: 0, cpu: 0 };
  }
}

const server = launch(SERVER_ENTRY);
const worker = launch(WORKER_ENTRY);
let serverErr = "", workerErr = "";
server.stderr.on("data", (d) => (serverErr += d));
worker.stderr.on("data", (d) => (workerErr += d));

function stopAll() {
  for (const p of [server, worker]) {
    try { p.kill("SIGTERM"); } catch {}
  }
}
process.on("exit", stopAll);

// wait for healthz
const healthUrl = `http://localhost:${PORT}/healthz`;
let ready = false;
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  try {
    const r = await fetch(healthUrl);
    if (r.ok) { ready = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!ready) {
  console.error("server never became ready. server stderr:\n" + serverErr + "\nworker stderr:\n" + workerErr);
  process.exit(1);
}
const bootMs = Date.now() - t0;

// idle baseline: sample for 3s
const idleSamples = { server: [], worker: [] };
for (let i = 0; i < 6; i++) {
  idleSamples.server.push(sample(server.pid).rss);
  idleSamples.worker.push(sample(worker.pid).rss);
  await new Promise((r) => setTimeout(r, 500));
}

// burst: fire load, sample every 500ms
const burst = { server: [], worker: [] };
const loadProc = spawn("node", ["bench/load.mjs",
  `http://localhost:${PORT}/webhook/openrouter`,
  process.env.WEBHOOK_SECRET, RPS, DURATION, "16"], { stdio: "pipe" });
let loadOut = "";
loadProc.stdout.on("data", (d) => (loadOut += d));

const burstEnd = Date.now() + Number(DURATION) * 1000 + 4000; // +4s drain for worker
while (Date.now() < burstEnd) {
  burst.server.push(sample(server.pid));
  burst.worker.push(sample(worker.pid));
  await new Promise((r) => setTimeout(r, 500));
}

const summarize = (arr) => {
  if (arr.length === 0) return { maxRssMb: 0, avgRssMb: 0, maxCpuPct: 0, avgCpuPct: 0 };
  const rss = arr.map((x) => x.rss);
  const cpu = arr.map((x) => x.cpu);
  return {
    maxRssMb: Number((Math.max(...rss) / 1024).toFixed(1)),
    avgRssMb: Number((rss.reduce((a, b) => a + b, 0) / rss.length / 1024).toFixed(1)),
    maxCpuPct: Number(Math.max(...cpu).toFixed(0)),
    avgCpuPct: Number((cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(0)),
  };
};

let loadResult = {};
try { loadResult = JSON.parse(loadOut || "{}"); } catch { loadResult = { raw: loadOut }; }

const report = {
  label: LABEL,
  runtime: RUNTIME,
  bootMs,
  idleServerRssMb: Number((Math.max(...idleSamples.server) / 1024).toFixed(1)),
  idleWorkerRssMb: Number((Math.max(...idleSamples.worker) / 1024).toFixed(1)),
  server: summarize(burst.server),
  worker: summarize(burst.worker),
  load: loadResult,
};
console.log(JSON.stringify(report, null, 2));
stopAll();
process.exit(0);
