# AGENTS.md

TypeScript service that ingests OpenRouter OTel webhooks into Postgres, then asynchronously parses them into `traces` + `llm_generations` tables via a separate worker process. Runs on **Bun** (1.4+) in development and production; TypeScript is executed directly, with no compile or bundle step.

## Verify before committing

```
bun run typecheck
bun test
```

`tsc --noEmit` is the only static check; it covers `src/` and `tests/`. `bun test` runs all three suites (unit, integration, e2e) sequentially in one process, sharing a single testcontainer Postgres. Always run both.

Coverage gate: `bun run test:coverage` writes `coverage/lcov.info` and runs `scripts/check-coverage.mjs`, which fails below **90% lines**. Bun 1.4 accepts `coverageThreshold` in `bunfig.toml` but never enforces it, which is why the explicit script exists. Current coverage is ~94%.

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `bun run typecheck` |
| Run migrations | `bun run migrate` |
| Dev server (HTTP ingest, hot reload) | `bun run dev` |
| Dev worker (parser, hot reload) | `bun run dev:worker` |
| Prod server | `bun run start` |
| Prod worker | `bun run start:worker` |
| Cleanup old raw events | `bun run cleanup` |
| Run all tests | `bun test` |
| Run tests in watch mode | `bun run test:watch` |
| Run tests with coverage + gate | `bun run test:coverage` |
| Run only unit tests | `bun run test:unit` |
| Run only integration tests | `bun run test:integration` |
| Run only e2e tests | `bun run test:e2e` |

Migrations must run before the server/worker can use the database. `bun run migrate` dynamically imports `.ts` migration files from `migrations/`.

## Architecture

Two independent processes that share one Postgres database:

- **Server** (`src/server.ts`): `Bun.serve` HTTP server. The `main()` function wires the live process; the testable seam is `createApp(db, config, logger)` (also exported) which returns a `Handler = (req: Request, socketIp?) => Promise<Response>` without binding a socket or installing signal handlers. `src/http.ts` provides the primitives (composition, router, JSON body reader, security headers, request logging, error mapping, rate limiter). Exposes `POST /webhook/openrouter` (auth-protected ingest that writes raw JSON to `raw_events`), `GET /healthz` (DB ping) and `GET /usage` (HTML dashboard).
- **Worker** (`src/worker/index.ts`): Polling loop. The testable seam is `startWorkerLoop({ db, logger, config })` (also exported), which returns `{ tick, stop }`. Each tick reaps stale `processing` rows (claimed > 5 min ago), claims a batch via `FOR UPDATE SKIP LOCKED`, calls `parseOtelPayload` in `src/worker/otel.ts`, and writes parsed traces/generations in a transaction.

Both processes must be running for end-to-end ingestion to land in `traces`/`llm_generations`.

## Data retention

- `bun run cleanup` deletes processed/failed `raw_events` older than `RAW_EVENT_RETENTION_DAYS` (default 7) and `traces` older than `TRACES_RETENTION_DAYS` (default 30). Deleting `traces` cascades to `llm_generations` (FK `ON DELETE CASCADE`). Both run in batches of 1000 to avoid long table locks.
- On Dokku the cleanup runs daily at 03:00 via `app.json` cron (`bun run cleanup`), or can be triggered manually with `bun run cleanup`.
- Index `raw_events_processing_claimed_idx` (partial on `claimed_at WHERE processing_status = 'processing'`) supports the worker's stale-row reaper.
- Index `traces_raw_event_id_idx` (partial on `raw_event_id WHERE raw_event_id IS NOT NULL`) is required by the FK `ON DELETE SET NULL` check when cleanup deletes `raw_events` — without it each deleted raw event seq-scans `traces`.
- Index `llm_generations_total_cost_idx` (partial on `total_cost WHERE total_cost IS NOT NULL`) backs the `/usage` dashboard's "most expensive calls" query.
- `usage_daily` (day × model rollup backing `GET /usage`) and `usage_hourly` (UTC hour × model, backing the activity heatmap) are **never pruned** by cleanup — buckets persist beyond trace retention by design. Day/hour boundaries are UTC (`AT TIME ZONE 'UTC'`), not server-timezone.
- **Disk space:** Postgres `DELETE` only marks tuples dead; steady-state reuse is handled by autovacuum (new inserts fill the reclaimed space), so no manual vacuum is needed for the daily cleanup. If you enable retention on a large accumulated history, run a one-time `VACUUM FULL traces, llm_generations` (brief exclusive lock; or use `pg_repack` for a lock-free rewrite) to return space to the OS. Do not put `VACUUM FULL` in the cron.

## TypeScript / toolchain

- **Bun 1.4+** runs TypeScript directly (`bun src/server.ts`); there is no compile/bundle step and no `dist/`. `tsc --noEmit` is typecheck-only.
- ESM (`"type": "module"`), `module=NodeNext`. **Imports keep `.js` extensions** even though sources are `.ts` (e.g. `import "./db.js"`); Bun resolves these to the `.ts` files. Keep this style — it keeps the tree valid under plain Node/tsc too.
- `tsconfig` enables `strict`, `noUncheckedIndexedAccess` (indexing returns `T | undefined`), `noEmit`, and `types: ["bun-types"]`. `bun-types` brings `@types/node` transitively, so there is no direct `@types/node` dependency.
- `bunfig.toml` configures the test runner (60s default timeout, lcov coverage reporter, coverage path ignores). Note that `coverageInclude` is a no-op in Bun 1.4 — use `coveragePathIgnorePatterns` with `**/`-prefixed globs.
- `Bun.serve` details that matter: `idleTimeout` defaults to 10s (raised to 60s in `server.ts` so slow uploads survive), and `maxRequestBodySize` defaults to 128MB (set just above `WEBHOOK_BODY_LIMIT` so our JSON 413 wins over Bun's plain-text one).
- Entrypoints use `if (import.meta.main)`, not argv parsing.

## Environment

- `.env` is auto-loaded by Bun itself (also `.env.local` and `.env.<NODE_ENV>` when present); `src/config.ts` only uses existence of `.env` to decide whether to show the setup tip. Do not add a `dotenv` import. Real environment variables take precedence over `.env` (Dokku config vars still win).
- Required env: `DATABASE_URL`, `WEBHOOK_SECRET`. All other vars have defaults (see `.env.example`).
- Config is validated with Zod and cached — changes to `process.env` after first `loadConfig()` call have no effect within the same process.
- `WEBHOOK_SECRETS` (optional, comma-separated) enables zero-downtime rotation — all listed secrets are accepted in addition to `WEBHOOK_SECRET`.
- `WEBHOOK_RATE_LIMIT_PER_MIN` (default 60) applies to `POST /webhook/openrouter`. Set to 0 to disable.

## Migrations

- Files live in `migrations/` and are named `NNNN_name.ts`. Migration name = filename without extension. This is relied on by the dynamic import in `src/migrate.ts`; renaming a file changes its identity and can cause re-execution or skipped migrations.
- Each migration exports `up`/`down` (or a default function). `up` only — there is no rollback command; `down` is defined for completeness but never invoked by `bun run migrate`.

## Ingest contract (non-obvious)

- Auth: webhook request must include header `X-Webhook-Signature` (configurable via `WEBHOOK_SECRET_HEADER`) whose value matches `WEBHOOK_SECRET` using `timingSafeEqual`. Header name comparison is lower-cased.
- Sending header `x-test-connection: true` short-circuits the webhook handler with `{ ok: true, test: true }` and writes nothing — used for connectivity tests.
- Body limit defaults to `10mb` (`WEBHOOK_BODY_LIMIT`). Oversized bodies return `413 { error: "payload_too_large" }`; malformed JSON returns `400 { error: "invalid_json" }`. Primitive JSON bodies (string/number/null/boolean at the top level) are rejected by the strict-mode check in `readJsonBody` and surface as `400 { error: "invalid_json" }`; only objects/arrays reach the handler. An empty body with a JSON content type parses to `{}` (body-parser parity), and a non-JSON content type is left unparsed so the handler returns `400 { error: "invalid_payload" }`.
- `POST /webhook/openrouter` sets `express-rate-limit`-compatible draft-6 headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`). Exceeding the limit returns `429 { error: "rate_limited" }`. Requests with `x-test-connection: true` are exempt from counting (they still require a valid auth header).
- Unknown paths/methods return a plain-text `404 Not Found` (Express returned HTML; this is the one intentional response-shape change).
- Security headers match `helmet()`'s defaults and are applied in `src/http.ts` (`securityHeaders`). The `/usage` page sets its own narrower `Content-Security-Policy`, which wins because route headers are preserved.

## Worker / parsing gotchas

- `storeParsedTraces` (`src/worker/store.ts`) upserts on `traces.openrouter_trace_id` and `(trace_id, span_id)` in `llm_generations`, then **deletes any `llm_generations` rows for that `trace_id` whose `span_id` is not in the incoming set** (via `span_id <> all(<array>)`, not `not in` — keeps bind params O(1)). Re-emitting a trace with a smaller span set removes the missing spans. The function does **not** wrap its own work in a transaction; `processBatch` calls it inside a `db.transaction()`, and standalone callers must do the same.
- `storeParsedTraces` also maintains `usage_daily` and `usage_hourly` within the same caller transaction: after the stale-span delete it recomputes every touched `(UTC day, request_model)` and `(UTC hour, request_model)` bucket from live `llm_generations` rows and upserts. `usage_daily` carries tokens/cost, call-weighted `avg/p50/p95 duration_ms`, jsonb mixes (`status_counts`, `finish_reason_counts`, `provider_counts`, `response_model_counts`) and `prompt_chars`/`completion_chars`; `usage_hourly` carries tokens/cost. Migration `0007` backfilled only the new aggregate columns for buckets that had live rows at migrate time, preserving each bucket's original tokens/cost totals — buckets whose `llm_generations` rows were already pruned keep their original columns and stay NULL for the newer aggregates. Known limitation: a bucket whose **every** row was removed by a re-emit (span moved day/hour/model) is never refreshed and stays stale until that bucket is touched again; concurrent workers can transiently write a stale aggregate for a shared bucket (last writer wins).
- `llm_generations` has **no** `raw_attributes` column — span attributes were stored duplicated with `prompt`/`completion`; they are dropped after parsing. Don't re-add unless there's a real consumer.
- `traces.metadata` jsonb excludes the keys promoted to columns (`trace.metadata.openrouter.{entity_id, api_key_name, provider_name, provider_slug}`, `trace.metadata.{environment, source}`) — unit-price keys are NOT stripped (they have no trace column; `llm_generations` carries the parsed values).
- Worker connections run `SET synchronous_commit = OFF` via the `onConnect` hook on `createDb` — a crash may lose the last few ms of acked worker writes (acceptable for a log store). The web server keeps durable commits.
- `forJsonb` is exported from `src/worker/store.ts` (used to be private). It wraps arrays in `JSON.stringify` before insert because the `pg` driver does not auto-stringify arrays for `jsonb` columns. When adding new jsonb columns that can receive arrays, do the same.
- Postgres `text`/`jsonb` reject `\u0000` and unpaired UTF-16 surrogates. Those arrive as escapes inside inner JSON attribute strings (e.g. `gen_ai.prompt`, `trace.input`, `trace.tags`) and materialize when `parseOtelPayload` calls `JSON.parse`. `src/sanitize.ts` replaces them with U+FFFD; the parser sanitizes every attribute string and decoded JSON value, and the webhook sanitizes `raw_events.payload` before insert. Do not remove this — without it the whole generation upsert fails with `unsupported Unicode escape sequence` and the raw event retries until `failed`.
- `waitForDb(db, opts)` is exported from `src/db.ts`. It polls `SELECT 1` with retries (default 30 attempts, 1s delay). Used by server/main, worker/main, and migrate/main on startup to wait for Postgres readiness.
- `computeBackoffMs(attempt, base, max)` and `shouldFailAfter(attempt, maxAttempts)` are pure helpers exported from `src/worker/processBatch.ts`. `handleFailure` delegates to them; unit tests cover them directly.
- Failed parses/stores increment `attempt_count` and retry with exponential backoff (`WORKER_BACKOFF_BASE_MS`, `WORKER_BACKOFF_MAX_MS`) up to `MAX_PROCESSING_ATTEMPTS`, after which the row is marked `failed`.
- `raw_events.payload` is stored as `jsonb`. The Kysely typing says it's a `string` on insert and `unknown` on select — the `pg` driver auto-parses jsonb into JS values on read. Don't `JSON.parse` it on read.
- Unique constraints relied on: `traces.openrouter_trace_id` (unique), `llm_generations (trace_id, span_id)` (unique). Upserts depend on these.

## Testing

- **Runner:** `bun test` (bun:test). Test files run sequentially in one process, so the shared testcontainer is safe; there is no per-directory project config, so the suites are selected by path:
  - `tests/unit/**` — no external services.
  - `tests/integration/**` — testcontainer Postgres.
  - `tests/e2e/**` — same shared testcontainer Postgres, drives the full server + worker loop; `tests/e2e/http-server.test.ts` binds a real ephemeral `Bun.serve` port.
- **No vitest.** Do not reintroduce `vi.*`; use `mock()`/`spyOn` from `bun:test`. Note that a mock cast to a framework type (e.g. `as unknown as NextFunction`) loses `.mock`; keep a separate typed mock handle for assertions.
- **Docker is required for `test:integration` and `test:e2e`.** The Docker daemon must be running; importing `tests/fixtures/db.ts` fails fast with `Could not find a working container runtime strategy` if it isn't. Unit tests never import it, so `bun run test:unit` works without Docker.
- **Fixtures** live in `tests/fixtures/`:
  - `db.ts` — starts the Postgres testcontainer lazily via **top-level await** on first import, runs all migrations, and exposes `getTestDb()` (synchronous), `truncateAll()`, `seedRawEvent(payload)`. The top-level await is what guarantees the DB exists before any test body runs, so call sites stay synchronous. Set `TEST_DATABASE_URL` to reuse an external database and skip the container.
  - `app.ts` — `createTestApp({ db, config? })` returns the fetch `Handler` from `createApp`.
  - `http.ts` — `call(handler, path, { method, headers, json, body, socketIp })` invokes a handler with a synthesized `Request` (no port bound; replaces supertest), plus `get(handler, path)` for text assertions.
  - `otel_payloads.ts` — builders for OTel payloads (resourceSpan/scopeSpan/span attribute factories, `makeMinimalValidOtel`, `makeParsedTraceFor`).
  - The container is stopped on process exit (SIGINT/SIGTERM/exit hooks).
- **Test seams extracted to make this work** (behavior-preserving, do not regress):
  - `createApp(db, config, logger)` exported from `src/server.ts` (returns a fetch `Handler`).
  - `startWorkerLoop({ db, logger, config })` exported from `src/worker/index.ts`, returning `{ tick, stop }`.
  - `forJsonb` exported from `src/worker/store.ts`.
  - `computeBackoffMs`, `shouldFailAfter` exported from `src/worker/processBatch.ts`.
- **Pick the right test level per change.** Unit tests for pure logic (e.g. `parseOtelPayload`, `forJsonb`, `computeBackoffMs`, `shouldFailAfter`, `parseEnv`, HTTP primitives, logger). Integration tests for code that touches Postgres (webhook ingest, `storeParsedTraces` upserts, worker claim/reap, migrations, usage page). E2e tests for the full server→worker→DB path and for real-socket `Bun.serve` behavior. When adding a change, choose the smallest layer that still verifies the behavior.

## Code standards

- **Functional style preferred.** Prefer pure functions, immutable data, and expression-based transforms over mutation and class hierarchies. Kysely's query builder and the parser functions in `src/worker/otel.ts` are the existing idiom to follow.
- **Strong typing — no `any`.** `tsconfig` is `strict` with `noImplicitAny`, but explicit `any` is still permitted by the compiler; do not use it. Use `unknown` + narrowing, or model the type. This applies to function signatures, generic args, casts, and `catch` bindings.
- **Tests required for all new code.** Coverage target is ≥ 90% lines (`bun run test:coverage`). New tests go in the appropriate directory (`tests/unit`, `tests/integration`, or `tests/e2e`) and run via `bun test`. If you add new jsonb-array columns, mirror `forJsonb` and add a round-trip test in `tests/integration/storeParsedTraces.test.ts`.
