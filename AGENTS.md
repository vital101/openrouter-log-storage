# AGENTS.md

TypeScript service that ingests OpenRouter OTel webhooks into Postgres, then asynchronously parses them into `traces` + `llm_generations` tables via a separate worker process.

## Verify before committing

```
npm run typecheck
npm test
```

`tsc --noEmit` is the only static check; it now also covers tests under `tests/`. `npm test` runs the Vitest suite (unit + integration + e2e, sequentially per project, sharing a single testcontainer Postgres across the integration/e2e projects). Always run both. Coverage target is ≥ 90% statements (currently ~95%); the coverage report is produced by `npm run test:coverage` and lives in `coverage/`.

## Commands

| Task | Command |
| --- | --- |
| Typecheck (also covers `tests/`) | `npm run typecheck` |
| Build (`tsc` → `dist/`, excludes tests) | `npm run build` |
| Run migrations | `npm run migrate` |
| Dev server (HTTP ingest) | `npm run dev` |
| Dev worker (parser) | `npm run dev:worker` |
| Prod server | `npm run start` |
| Prod worker | `npm run start:worker` |
| Cleanup old raw events | `npm run cleanup` |
| Run all tests | `npm test` |
| Run tests in watch mode | `npm run test:watch` |
| Run tests with coverage | `npm run test:coverage` |
| Run only unit tests | `npm run test:unit` |
| Run only integration tests | `npm run test:integration` |
| Run only e2e tests | `npm run test:e2e` |

Migrations must run before the server/worker can use the database. `npm run migrate` uses `tsx` to dynamically import `.ts` migration files from `migrations/`.

## Architecture

Two independent processes that share one Postgres database:

- **Server** (`src/server.ts`): Express 5 HTTP server. The `main()` function wires the live process; the testable seam is `createApp(db, config, logger)` (also exported from `src/server.ts`) which returns the Express app without `app.listen` or signal handlers. Exposes `POST /webhook/openrouter` (auth-protected ingest that writes raw JSON to `raw_events`) and `GET /healthz` (DB ping).
- **Worker** (`src/worker/index.ts`): Polling loop. The testable seam is `startWorkerLoop({ db, logger, config })` (also exported), which returns `{ tick, stop }`. Each tick reaps stale `processing` rows (claimed > 5 min ago), claims a batch via `FOR UPDATE SKIP LOCKED`, calls `parseOtelPayload` in `src/worker/otel.ts`, and writes parsed traces/generations in a transaction.

Both processes must be running for end-to-end ingestion to land in `traces`/`llm_generations`.

## Data retention

- `npm run cleanup` deletes processed/failed `raw_events` older than `RAW_EVENT_RETENTION_DAYS` (default 7). Runs in batches of 1000 to avoid long table locks.
- On Dokku the cleanup runs daily at 03:00 via `app.json` cron, or can be triggered manually with `npm run cleanup`.
- Index `raw_events_processing_claimed_idx` (partial on `claimed_at WHERE processing_status = 'processing'`) supports the worker's stale-row reaper.

## TypeScript / toolchain

- Node 26.5.0 (`.nvmrc`); ESM (`"type": "module"`), `module=NodeNext`.
- **Imports must use `.js` extensions** even though source files are `.ts` (e.g. `import "./db.js"`). This is mandatory under NodeNext.
- `tsconfig` enables `strict` and `noUncheckedIndexedAccess` — array/record indexing returns `T | undefined`.
- `tsx` runs TS directly in dev and for migrations; `tsc` is only used for the `dist/` build and `typecheck`.
- Two tsconfigs: `tsconfig.json` (includes `src/` and `tests/`, no `rootDir` — used for `typecheck`) and `tsconfig.build.json` (extends base, sets `rootDir: "src"`, excludes `tests/` — used for `build` so test files don't ship in `dist/`).

## Environment

- `.env` is auto-loaded by `process.loadEnvFile` in `src/config.ts`. Do not add a `dotenv` import.
- Required env: `DATABASE_URL`, `WEBHOOK_SECRET`. All other vars have defaults (see `.env.example`).
- Config is validated with Zod and cached — changes to `process.env` after first `loadConfig()` call have no effect within the same process.
- `WEBHOOK_SECRETS` (optional, comma-separated) enables zero-downtime rotation — all listed secrets are accepted in addition to `WEBHOOK_SECRET`.
- `WEBHOOK_RATE_LIMIT_PER_MIN` (default 60) applies to `POST /webhook/openrouter`. Set to 0 to disable.

## Migrations

- Files live in `migrations/` and are named `NNNN_name.ts`. Migration name = filename without extension. This is relied on by the dynamic import in `src/migrate.ts`; renaming a file changes its identity and can cause re-execution or skipped migrations.
- Each migration exports `up`/`down` (or a default function). `up` only — there is no rollback command; `down` is defined for completeness but never invoked by `npm run migrate`.

## Ingest contract (non-obvious)

- Auth: webhook request must include header `X-Webhook-Signature` (configurable via `WEBHOOK_SECRET_HEADER`) whose value matches `WEBHOOK_SECRET` using `timingSafeEqual`. Header name comparison is lower-cased.
- Sending header `x-test-connection: true` short-circuits the webhook handler with `{ ok: true, test: true }` and writes nothing — used for connectivity tests.
- Body limit defaults to `10mb` (`WEBHOOK_BODY_LIMIT`). Oversized bodies return `413 { error: "payload_too_large" }`; malformed JSON returns `400 { error: "invalid_json" }`. Primitive JSON bodies (string/number/null at the top level) are rejected upstream by `express.json`'s strict mode and surface as `400 { error: "invalid_json" }`; only objects/arrays reach the handler.

## Worker / parsing gotchas

- `storeParsedTraces` (`src/worker/store.ts`) upserts on `traces.openrouter_trace_id` and `(trace_id, span_id)` in `llm_generations`, then **deletes any `llm_generations` rows for that `trace_id` whose `span_id` is not in the incoming set**. Re-emitting a trace with a smaller span set removes the missing spans. The function does **not** wrap its own work in a transaction; `processBatch` calls it inside a `db.transaction()`, and standalone callers must do the same.
- `forJsonb` is exported from `src/worker/store.ts` (used to be private). It wraps arrays in `JSON.stringify` before insert because the `pg` driver does not auto-stringify arrays for `jsonb` columns. When adding new jsonb columns that can receive arrays, do the same.
- `waitForDb(db, opts)` is exported from `src/db.ts`. It polls `SELECT 1` with retries (default 30 attempts, 1s delay). Used by server/main, worker/main, and migrate/main on startup to wait for Postgres readiness.
- `computeBackoffMs(attempt, base, max)` and `shouldFailAfter(attempt, maxAttempts)` are pure helpers exported from `src/worker/processBatch.ts`. `handleFailure` delegates to them; unit tests cover them directly.
- Failed parses/stores increment `attempt_count` and retry with exponential backoff (`WORKER_BACKOFF_BASE_MS`, `WORKER_BACKOFF_MAX_MS`) up to `MAX_PROCESSING_ATTEMPTS`, after which the row is marked `failed`.
- `raw_events.payload` is stored as `jsonb`. The Kysely typing says it's a `string` on insert and `unknown` on select — the `pg` driver auto-parses jsonb into JS values on read. Don't `JSON.parse` it on read.
- Unique constraints relied on: `traces.openrouter_trace_id` (unique), `llm_generations (trace_id, span_id)` (unique). Upserts depend on these.

## Testing

- **Runner:** Vitest 4 with three projects declared in `vitest.config.ts`:
  - `unit` — `tests/unit/**`, no external services, 5s timeout.
  - `integration` — `tests/integration/**`, testcontainer Postgres (single container per run, shared across files via `process.env.TEST_DATABASE_URL` set in `globalSetup`).
  - `e2e` — `tests/e2e/**`, same shared testcontainer Postgres, drives the full server + worker loop.
  - Both DB-touching projects run with `fileParallelism: false` and `sequence: { concurrent: false }` because they share one container and `truncateAll` between tests.
- **Docker is required for `test:integration` and `test:e2e`.** The Docker daemon must be running. `globalSetup` will fail fast with `Could not find a working container runtime strategy` if it isn't.
- **Fixtures** live in `tests/fixtures/`:
  - `db.ts` — `getTestDb()`, `truncateAll()`, `seedRawEvent(payload)`. Each worker process lazily memoizes a Kysely instance from `TEST_DATABASE_URL`.
  - `app.ts` — `createTestApp({ db, config? })` returns a supertest-ready Express app via `createApp`.
  - `otel_payloads.ts` — builders for OTel payloads (resourceSpan/scopeSpan/span attribute factories, `makeMinimalValidOtel`, `makeParsedTraceFor`).
  - `global-setup.ts` — Vitest `globalSetup` that starts a `postgres:16-alpine` testcontainer, runs all migrations, sets `TEST_DATABASE_URL` for workers, stops the container on teardown.
- **Test seams extracted to make this work** (behavior-preserving, do not regress):
  - `createApp(db, config, logger)` exported from `src/server.ts`.
  - `startWorkerLoop({ db, logger, config })` exported from `src/worker/index.ts`, returning `{ tick, stop }`.
  - `forJsonb` exported from `src/worker/store.ts`.
  - `computeBackoffMs`, `shouldFailAfter` exported from `src/worker/processBatch.ts`.
- **Pick the right test level per change.** Unit tests for pure logic (e.g. `parseOtelPayload`, `forJsonb`, `computeBackoffMs`, `shouldFailAfter`, config parsing, middleware factories). Integration tests for code that touches Postgres or Express (webhook ingest, `storeParsedTraces` upserts, worker claim/reap, migrations). E2e tests for the full server→worker→DB path. When adding a change, choose the smallest layer that still verifies the behavior.

## Code standards

- **Functional style preferred.** Prefer pure functions, immutable data, and expression-based transforms over mutation and class hierarchies. Kysely's query builder and the parser functions in `src/worker/otel.ts` are the existing idiom to follow.
- **Strong typing — no `any`.** `tsconfig` is `strict` with `noImplicitAny`, but explicit `any` is still permitted by the compiler; do not use it. Use `unknown` + narrowing, or model the type. This applies to function signatures, generic args, casts, and `catch` bindings.
- **Tests required for all new code.** Coverage target is ≥ 90% statements. The harness is now in place — new tests go in the appropriate project (`tests/unit`, `tests/integration`, or `tests/e2e`) and run via `npm test`. If you add new jsonb-array columns, mirror `forJsonb` and add a round-trip test in `tests/integration/storeParsedTraces.test.ts`.
