# Bun migration benchmarks

Measured with `bench/measure.mjs` (launches `dist/server.js` + `dist/worker/index.js`,
samples RSS/CPU every 500ms, fires `bench/load.mjs` at 50 rps for 30s against a
scratch DB `openrouter_logs_bench` with migrations applied). Load payload: 20 spans
per webhook with prompt/completion attrs (~4.6 KB body each).

Run (Node baseline, pre-migration):

```
node bench/measure.mjs node baseline-node
```

Run (Bun, post-migration — same harness, `bun src/server.ts` / `bun src/worker/index.ts`):

```
BENCH_RPS=50 BENCH_DURATION=30 node bench/measure.mjs bun post-migration
```

## Results

| Metric | Node 26 (pre) | Bun 1.4 (post) |
|---|---|---|
| Cold start to /healthz 200 | 455 ms | _TBD_ |
| Idle RSS server | 99.2 MB | _TBD_ |
| Idle RSS worker | 86.3 MB | _TBD_ |
| Burst RSS server max / avg | 152.7 / 137.6 MB | _TBD_ |
| Burst RSS worker max / avg | 161.8 / 138.8 MB | _TBD_ |
| Burst CPU server max / avg | 15 / 8 % | _TBD_ |
| Burst CPU worker max / avg | 18 / 3 % | _TBD_ |
| Sustained rps (50 target) | 50.0 | _TBD_ |
| Ingest MB/s | 6.88 | _TBD_ |
| Errors during burst | 0 | _TBD_ |

## Node baseline raw output (2026-10-31, branch bun-migration pre-change)

```json
{
  "label": "baseline-node",
  "runtime": "node",
  "bootMs": 455,
  "idleServerRssMb": 99.2,
  "idleWorkerRssMb": 86.3,
  "server": { "maxRssMb": 152.7, "avgRssMb": 137.6, "maxCpuPct": 15, "avgCpuPct": 8 },
  "worker": { "maxRssMb": 161.8, "avgRssMb": 138.8, "maxCpuPct": 18, "avgCpuPct": 3 },
  "load": { "ok": 1500, "fail": 0, "elapsedSec": 30, "rps": 50, "attemptedRps": 50, "mbPerSec": 6.88, "inflightPeak": 3 }
}
```
