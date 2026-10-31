# Bun migration benchmarks

Measured with `bench/measure.mjs` (30s burst) and `bench/soak.mjs` (120s
sustained load, 5s RSS sampling) against the scratch DB
`openrouter_logs_bench`. Load payload: 20 spans per webhook with
prompt/completion attributes (~4.6 KB body each), 50 requests/second.

- **Node baseline:** pre-migration tree (`75a71e5`), `node dist/server.js` + `node dist/worker/index.js`
- **Bun:** post-migration tree, `bun src/server.ts` + `bun src/worker/index.ts`

```
# baseline
node bench/measure.mjs node baseline-node
SOAK_RUNTIME=node node bench/soak.mjs 120 50

# post-migration
node bench/measure.mjs bun post-bun-final
node bench/soak.mjs 120 50
```

## 30-second burst

| Metric | Node 26 | Bun 1.4 | Change |
|---|---|---|---|
| Cold start to /healthz 200 | 455 ms | 310 ms | −32% |
| Idle RSS, server | 99.2 MB | 46.9 MB | −53% |
| Idle RSS, worker | 86.3 MB | 46.5 MB | −46% |
| Burst RSS, server max / avg | 152.7 / 137.6 MB | 71.9 / 61.1 MB | −53% / −56% |
| Burst RSS, worker max / avg | 161.8 / 138.8 MB | 92.9 / 54.4 MB | −43% / −61% |
| Sustained rps (50 target) | 50.0 | 50.0 | — |
| Ingest MB/s | 6.88 | 6.88 | — |
| Errors | 0 | 0 | — |
| Test suite wall time | ~10.2 s | ~5.2 s | −49% |

## 120-second sustained load (RSS in MB)

Both runs: 6000 requests, 50 rps, 0 failures.

| Process / metric | Node 26 | Bun 1.4 | Change |
|---|---|---|---|
| Server RSS, first-half avg | 162.0 | 95.7 | −41% |
| Server RSS, second-half avg | 152.2 | 98.1 | −36% |
| Server RSS, peak | 166.3 | 108.8 | −35% |
| Server RSS, after 30s idle | 130.2 | 76.7 | −41% |
| Worker RSS, first-half avg | 133.0 | 95.6 | −28% |
| Worker RSS, second-half avg | 114.3 | 108.1 | −5% |
| Worker RSS, peak | 149.1 | 132.7 | −11% |
| Worker RSS, after 30s idle | 113.2 | 114.4 | ~0% |

## Notes

- Both runtimes saturate the 50 rps target exactly, so this harness measures
  memory and startup, not maximum throughput (Postgres writes are the
  bottleneck at this rate).
- RSS is not flat under sustained load in either runtime: both oscillate as the
  heap grows and is collected. Bun's idle tail drops back toward its baseline,
  confirming the growth is lazy GC rather than an unbounded leak.
- `bun --smol` was measured over 120s and made no meaningful difference
  (server peak 106.6 MB vs 108.8 MB, worker 136 MB vs 132.7 MB), so production
  does **not** use it.
- The worker's advantage is smaller than the server's, which is expected: it is
  Postgres-I/O bound and its RSS is dominated by batch payloads rather than
  runtime overhead.

## Raw output

Node 26, 30s burst:

```json
{
  "label": "baseline-node", "runtime": "node", "bootMs": 455,
  "idleServerRssMb": 99.2, "idleWorkerRssMb": 86.3,
  "server": { "maxRssMb": 152.7, "avgRssMb": 137.6, "maxCpuPct": 15, "avgCpuPct": 8 },
  "worker": { "maxRssMb": 161.8, "avgRssMb": 138.8, "maxCpuPct": 18, "avgCpuPct": 3 },
  "load": { "ok": 1500, "fail": 0, "elapsedSec": 30, "rps": 50, "mbPerSec": 6.88 }
}
```

Bun 1.4, 30s burst:

```json
{
  "label": "post-bun-final", "runtime": "bun", "bootMs": 310,
  "idleServerRssMb": 46.9, "idleWorkerRssMb": 46.5,
  "server": { "maxRssMb": 71.9, "avgRssMb": 61.1, "maxCpuPct": 16, "avgCpuPct": 10 },
  "worker": { "maxRssMb": 92.9, "avgRssMb": 54.4, "maxCpuPct": 9, "avgCpuPct": 3 },
  "load": { "ok": 1500, "fail": 0, "elapsedSec": 30, "rps": 50, "mbPerSec": 6.88 }
}
```

Node 26, 120s soak summary:

```json
{
  "server": { "firstHalfAvgMb": 162, "secondHalfAvgMb": 152.2, "peakMb": 166.3 },
  "worker": { "firstHalfAvgMb": 133, "secondHalfAvgMb": 114.3, "peakMb": 149.1 },
  "load": { "ok": 6000, "fail": 0, "elapsedSec": 120, "rps": 50 }
}
```

Bun 1.4, 120s soak summary:

```json
{
  "server": { "firstHalfAvgMb": 95.7, "secondHalfAvgMb": 98.1, "peakMb": 108.8 },
  "worker": { "firstHalfAvgMb": 95.6, "secondHalfAvgMb": 108.1, "peakMb": 132.7 },
  "load": { "ok": 6000, "fail": 0, "elapsedSec": 120, "rps": 50 }
}
```
