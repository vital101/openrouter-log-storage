import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../types.js";
import type { Logger } from "pino";
import { parseOtelPayload } from "./otel.js";
import { storeParsedTraces } from "./store.js";

export interface ProcessBatchDeps {
  db: Kysely<Database>;
  logger: Logger;
  batchSize: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface ProcessResult {
  processed: number;
  failed: number;
}

interface ClaimedRow {
  id: number;
  attempt_count: number;
  payload: unknown;
}

interface ParsedOk {
  id: number;
  attempt_count: number;
  kind: "ok";
  parsed: ReturnType<typeof parseOtelPayload>;
}

interface ParsedErr {
  id: number;
  attempt_count: number;
  kind: "err";
  error: string;
}

async function reapStaleProcessing(db: Kysely<Database>): Promise<void> {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  await db
    .updateTable("raw_events")
    .set({
      processing_status: "pending",
      claimed_at: null,
      processing_error: null,
    })
    .where("processing_status", "=", "processing")
    .where((eb) =>
      eb.or([
        eb("claimed_at", "is", null),
        eb("claimed_at", "<", staleThreshold),
      ]),
    )
    .execute();
}

async function claimBatch(
  db: Kysely<Database>,
  batchSize: number,
): Promise<ClaimedRow[]> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("raw_events")
      .select(["id", "payload", "attempt_count"])
      .where("processing_status", "=", "pending")
      .where((eb) =>
        eb.or([
          eb("next_attempt_at", "is", null),
          eb("next_attempt_at", "<=", new Date()),
        ]),
      )
      .orderBy(sql`next_attempt_at asc nulls first`)
      .orderBy("received_at", "asc")
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();

    if (rows.length === 0) return [];

    await trx
      .updateTable("raw_events")
      .set({ processing_status: "processing", claimed_at: new Date() })
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();

    return rows;
  });
}

async function handleFailure(
  trx: Kysely<Database>,
  id: number,
  attemptCount: number,
  error: string,
  deps: ProcessBatchDeps,
): Promise<void> {
  const newAttemptCount = attemptCount + 1;

  if (newAttemptCount >= deps.maxAttempts) {
    await trx
      .updateTable("raw_events")
      .set({
        processing_status: "failed",
        processing_error: error,
        attempt_count: newAttemptCount,
        next_attempt_at: null,
      })
      .where("id", "=", id)
      .execute();
  } else {
    const backoffMs = Math.min(
      deps.backoffBaseMs * Math.pow(2, newAttemptCount - 1),
      deps.backoffMaxMs,
    );
    await trx
      .updateTable("raw_events")
      .set({
        processing_status: "pending",
        processing_error: error,
        attempt_count: newAttemptCount,
        next_attempt_at: new Date(Date.now() + backoffMs),
      })
      .where("id", "=", id)
      .execute();
  }
}

export async function processBatch(
  deps: ProcessBatchDeps,
): Promise<ProcessResult> {
  const { db, logger } = deps;

  await reapStaleProcessing(db);

  const claimed = await claimBatch(db, deps.batchSize);
  if (claimed.length === 0) return { processed: 0, failed: 0 };

  const results: (ParsedOk | ParsedErr)[] = claimed.map((row) => {
    try {
      const parsed = parseOtelPayload(row.payload);
      return {
        id: row.id,
        attempt_count: row.attempt_count,
        kind: "ok",
        parsed,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ id: row.id, err: message }, "parse failed");
      return {
        id: row.id,
        attempt_count: row.attempt_count,
        kind: "err",
        error: message,
      };
    }
  });

  return db.transaction().execute(async (trx) => {
    let processed = 0;
    let failed = 0;

    for (const result of results) {
      if (result.kind === "err") {
        await handleFailure(
          trx,
          result.id,
          result.attempt_count,
          result.error,
          deps,
        );
        failed++;
      } else if (result.parsed.length === 0) {
        await trx
          .updateTable("raw_events")
          .set({
            processing_status: "processed",
            processed_at: new Date(),
            processing_error: null,
            next_attempt_at: null,
          })
          .where("id", "=", result.id)
          .execute();
        processed++;
      } else {
        try {
          await storeParsedTraces(trx, result.id, result.parsed);
          await trx
            .updateTable("raw_events")
            .set({
              processing_status: "processed",
              processed_at: new Date(),
              processing_error: null,
              next_attempt_at: null,
            })
            .where("id", "=", result.id)
            .execute();
          processed++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ id: result.id, err: message }, "store failed");
          await handleFailure(
            trx,
            result.id,
            result.attempt_count,
            message,
            deps,
          );
          failed++;
        }
      }
    }

    return { processed, failed };
  });
}
