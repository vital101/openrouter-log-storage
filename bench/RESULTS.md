# Bun migration benchmarks

Measured with `bench/measure.mjs` (samples RSS/CPU every 500ms, fires
`bench/load.mjs` at 50 rps for 30s against the scratch DB
`openrouter_logs_bench`). Load payload: 20 spans per webhook with
prompt/completion attributes (~4.6 KB body each).

- **Node baseline:** pre-migration tree, `node dist/server.js` + `node dist/worker/index.js`
- **Bun post:** post-migration tree, `bun src/server.ts` + `bun src/worker/index.ts`

```
# baseline (pre-migration)
node bench/measure.mjs node baseline-node

# post-migration
node bench/measure.mjs bun post-bun
```

## Results

| Metric | Node 26 (pre) | Bun 1.4 (post) | Change |
|---|---|---|---|
| Cold start to /healthz 200 | 455 ms | 310 ms | −32% |
| Idle RSS, server | 99.2 MB | 46.9 MB | −53% |
| Idle RSS, worker | 86.3 MB | 46.5 MB | −46% |
| Burst RSS, server max | 152.7 MB | 79.4 MB | −48% |
| Burst RSS, server avg | 137.6 MB | 68.2 MB | −50% |
| Burst RSS, worker max | 161.8 MB | 94.7 MB | −41% |
| Burst RSS, worker avg | 138.8 MB | 61.8 MB | −55% |
| Burst CPU, server max / avg | 15% / 8% | 14% / 6% | −25% avg |
| Burst CPU, worker max / avg | 18% / 3% | 12% / 2% | −33% avg |
| Sustained rps (50 target) | 50.0 | 50.0 | — |
| Ingest MB/s | 6.88 | 6.88 | — |
| Errors during burst | 0 | 0 | — |
| Test suite wall time | ~10.2 s | ~5.7 s | −44% |

Both runs hit the 50 rps target exactly (the load generator is the limiter, not
the server), so throughput is not the differentiator here — memory and startup
are. Bun accepted requests with more overlap (`inflightPeak` 19 vs 3) because it
returns to the load generator faster while Postgres writes are the real
bottleneck.

## Raw output

Node baseline (pre-migration):

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

Bun (post-migration):

```json
{
  "label": "post-bun",
  "runtime": "bun",
  "bootMs": 310,
  "idleServerRssMb": 46.9,
  "idleWorkerRssMb": 46.5,
  "server": { "maxRssMb": 79.4, "avgRssMb": 68.2, "maxCpuPct": 14, "avgCpuPct": 6 },
  "worker": { "maxRssMb": 94.7, "avgRssMb": 61.8, "maxCpuPct": 12, "avgCpuPct": 2 },
  "load": { "ok": 1500, "fail": 0, "elapsedSec": 30, "rps": 50, "attemptedRps": 50, "mbPerSec": 6.88, "inflightPeak": 19 }
}
```
