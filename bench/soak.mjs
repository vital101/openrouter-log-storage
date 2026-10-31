// Soak test: sustained load while sampling RSS, to catch unbounded growth
// (GC differences between Bun and Node show up over minutes, not seconds).
//
// Usage: node bench/soak.mjs [seconds] [rps]
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOAD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "load.mjs");

const SECONDS = Number(process.argv[2] ?? 120);
const RPS = process.argv[3] ?? "50";
const PORT = Number(process.env.BENCH_PORT || 3100);

const env = { ...process.env, PORT: String(PORT) };
// SOAK_SMOL=1 runs both processes with Bun's --smol flag (lower RSS, more GC).
const BUN_ARGS = process.env.SOAK_SMOL === "1" ? ["--smol"] : [];
const RUNTIME = process.env.SOAK_RUNTIME || "bun";
const ENTRIES = RUNTIME === "bun"
  ? { server: ["src/server.ts"], worker: ["src/worker/index.ts"] }
  : { server: ["dist/server.js"], worker: ["dist/worker/index.js"] };
const bin = RUNTIME === "bun" ? ["bun", ...BUN_ARGS] : ["node"];
const server = spawn(bin[0], [...bin.slice(1), ...ENTRIES.server], { stdio: "pipe", env });
const worker = spawn(bin[0], [...bin.slice(1), ...ENTRIES.worker], { stdio: "pipe", env });

const stopAll = () => {
  for (const p of [server, worker]) {
    try { p.kill("SIGTERM"); } catch {}
  }
};
process.on("exit", stopAll);

function rssMb(pid) {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Number((Number(out) / 1024).toFixed(1));
  } catch {
    return 0;
  }
}

// wait for readiness
const t0 = Date.now();
for (;;) {
  try {
    if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break;
  } catch {}
  if (Date.now() - t0 > 30_000) { console.error("server never ready"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 200));
}

const load = spawn("node", [LOAD_SCRIPT,
  `http://localhost:${PORT}/webhook/openrouter`,
  process.env.WEBHOOK_SECRET, RPS, String(SECONDS), "16"], { stdio: "pipe" });
let loadOut = "";
load.stdout.on("data", (d) => (loadOut += d));

const samples = [];
const deadline = Date.now() + SECONDS * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = { t: Math.round((Date.now() - t0) / 1000), server: rssMb(server.pid), worker: rssMb(worker.pid) };
  samples.push(s);
  console.log(`t+${String(s.t).padStart(3)}s  server ${String(s.server).padStart(6)} MB   worker ${String(s.worker).padStart(6)} MB`);
}

const exited = new Promise((resolve) => {
  if (load.exitCode !== null) resolve();
  else load.on("exit", () => resolve());
});
await exited;

// Idle tail: if RSS falls after load stops, growth was lazy GC, not a leak.
const idleSamples = [];
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  idleSamples.push({ server: rssMb(server.pid), worker: rssMb(worker.pid) });
}
console.log("idle tail:", JSON.stringify(idleSamples.map((s) => ({ s: s.server, w: s.worker }))));

const half = Math.floor(samples.length / 2);
const avg = (arr) => Number((arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length)).toFixed(1));
const first = samples.slice(0, half);
const second = samples.slice(half);

console.log(JSON.stringify({
  seconds: SECONDS,
  rps: Number(RPS),
  load: JSON.parse(loadOut || "{}"),
  server: {
    firstHalfAvgMb: avg(first.map((s) => s.server)),
    secondHalfAvgMb: avg(second.map((s) => s.server)),
    peakMb: Math.max(...samples.map((s) => s.server)),
  },
  worker: {
    firstHalfAvgMb: avg(first.map((s) => s.worker)),
    secondHalfAvgMb: avg(second.map((s) => s.worker)),
    peakMb: Math.max(...samples.map((s) => s.worker)),
  },
  idleTailLastMb: idleSamples[idleSamples.length - 1] ?? null,
}, null, 2));

stopAll();
process.exit(0);
