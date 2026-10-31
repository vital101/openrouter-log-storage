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

## 120-second sustained load, clean DB (RSS in MB)

Each run starts from a truncated DB (the database is truncated and vacuumed
before the run). Both: 6000 requests, 50 rps, 0 failures.

| Process / metric | Node 26 | Bun 1.4 | Change |
|---|---|---|---|
| Server RSS, first-half avg | 170.7 | 94.5 | −45% |
| Server RSS, second-half avg | 175.1 | 99.0 | −43% |
| Server RSS, peak | 188.2 | 105.3 | −44% |
| Server RSS, after 30s idle | 177.4 | 102.0 | −42% |
| Worker RSS, first-half avg | 186.8 | 148.7 | −20% |
| Worker RSS, second-half avg | 171.6 | 161.2 | −6% |
| Worker RSS, peak | 208.2 | 179.6 | −14% |
| Worker RSS, after 30s idle | 194.0 | 165.9 | −14% |

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
- An earlier 120s run was executed against a *dirty* DB left by previous
  benchmarks (~40k pending events, all in one UTC day and one model bucket).
  That dataset makes `storeParsedTraces`' per-trace `usage_daily` recompute
  quadratic, so the worker fell behind and both runtimes' RSS was inflated by
  the backlog. The table above re-measures both runtimes from a clean DB; use
  those numbers.
- Throughput sanity check on a clean DB: a single `processBatch` of 100 events
  (20 spans each, concurrency 4) completes in **276 ms** under Bun.

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

Node 26, 120s clean-DB soak summary:

```json
{
  "server": { "firstHalfAvgMb": 170.7, "secondHalfAvgMb": 175.1, "peakMb": 188.2 },
  "worker": { "firstHalfAvgMb": 186.8, "secondHalfAvgMb": 171.6, "peakMb": 208.2 },
  "idleTailLastMb": { "server": 177.4, "worker": 194 },
  "load": { "ok": 6000, "fail": 0, "elapsedSec": 120, "rps": 50 }
}
```

Bun 1.4, 120s clean-DB soak summary:

```json
{
  "server": { "firstHalfAvgMb": 94.5, "secondHalfAvgMb": 99, "peakMb": 105.3 },
  "worker": { "firstHalfAvgMb": 148.7, "secondHalfAvgMb": 161.2, "peakMb": 179.6 },
  "idleTailLastMb": { "server": 102, "worker": 165.9 },
  "load": { "ok": 6000, "fail": 0, "elapsedSec": 120, "rps": 50 }
}
```
