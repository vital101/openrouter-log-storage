import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createLogger, serializeError } from "../../src/logger.js";

type Captured = Record<string, unknown>;

let lines: string[] = [];
let writeSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  lines = [];
  writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy?.mockRestore();
});

function parseLine(index = 0): Captured {
  const line = lines[index];
  if (line === undefined) throw new Error(`no log line at index ${index}`);
  return JSON.parse(line) as Captured;
}

describe("logger", () => {
  it("emits one JSON object per call with pino-compatible fields", () => {
    const log = createLogger("info");
    log.info({ port: 3000 }, "server listening");

    expect(lines).toHaveLength(1);
    const record = parseLine();
    expect(record["level"]).toBe(30);
    expect(typeof record["time"]).toBe("number");
    expect(record["service"]).toBe("openrouter-log-storage");
    expect(record["port"]).toBe(3000);
    expect(record["msg"]).toBe("server listening");
    expect(String(lines[0])).toEndWith("\n");
  });

  it("supports a string-only message", () => {
    const log = createLogger("info");
    log.warn("just a message");
    const record = parseLine();
    expect(record["level"]).toBe(40);
    expect(record["msg"]).toBe("just a message");
  });

  it("filters messages below the configured level", () => {
    const log = createLogger("warn");
    log.trace("t");
    log.debug("d");
    log.info("i");
    expect(lines).toHaveLength(0);

    log.warn("w");
    log.error("e");
    log.fatal("f");
    expect(lines).toHaveLength(3);
    expect(lines.map((_, i) => parseLine(i)["level"])).toEqual([40, 50, 60]);
  });

  it("emits nothing at the silent level", () => {
    const log = createLogger("silent");
    log.fatal({ err: new Error("boom") }, "should not print");
    expect(lines).toHaveLength(0);
  });

  it("merges child bindings and keeps them for nested children", () => {
    const log = createLogger("info").child({ component: "worker" });
    log.info("started");
    expect(parseLine()["component"]).toBe("worker");

    log.child({ shard: 2 }).info("shard log");
    const shard = parseLine(1);
    expect(shard["component"]).toBe("worker");
    expect(shard["shard"]).toBe(2);
  });

  it("serializes an Error under err like pino's stdSerializer", () => {
    const log = createLogger("info");
    log.error({ err: new Error("boom") }, "failed");

    const err = parseLine()["err"] as Record<string, unknown>;
    expect(err["type"]).toBe("Error");
    expect(err["message"]).toBe("boom");
    expect(String(err["stack"])).toContain("Error: boom");
  });

  it("serializes an Error passed as the first argument", () => {
    const log = createLogger("info");
    log.error(new Error("direct"));
    const err = parseLine()["err"] as Record<string, unknown>;
    expect(err["message"]).toBe("direct");
  });

  it("serializes nested causes and AggregateError members", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    const serialized = serializeError(outer);
    expect((serialized.cause as Record<string, unknown>)["message"]).toBe("inner");

    const aggregate = new AggregateError([new Error("a"), new Error("b")], "many");
    const agg = serializeError(aggregate);
    expect(agg.type).toBe("AggregateError");
    expect((agg.errors as Array<Record<string, unknown>>).map((e) => e["message"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("stringifies BigInt values", () => {
    const log = createLogger("info");
    log.info({ big: 123n }, "bigint");
    expect(parseLine()["big"]).toBe("123");
  });

  it("never throws on circular payloads", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;

    const log = createLogger("info");
    expect(() => log.info(circular, "circular")).not.toThrow();
    // Falls back to a minimal record rather than crashing the process.
    const record = parseLine();
    expect(record["level"]).toBe(30);
    expect(record["msg"]).toBe("circular");
  });
});
