import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerBridgeCore } from "../../../server/src/worker-bridge-core.js";
import { requestStartupArchiveMarker } from "./startup-session-query.js";

const marker = {
  sessionId: "fixture-session",
  summary: "fixture summary",
  toClientMessageId: "fixture-boundary",
  segmentId: "context-migration-v1",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(mode: "normal" | "noop" | "exit" | "never" | "error" | "invalid" = "normal") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "startup-session-query-")));
  const entryPath = join(directory, "worker.cjs");
  writeFileSync(
    entryPath,
    `const readline = require("node:readline");
const fs = require("node:fs");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync("requests.jsonl", JSON.stringify({ method: request.method,
    type: request.params.type, cwd: process.cwd() }) + "\\n");
  if (${JSON.stringify(mode)} === "exit") process.exit(1);
  if (${JSON.stringify(mode)} === "never") return;
  if (${JSON.stringify(mode)} === "error") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32602, message: "fixture Session is closed" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
    result: { type: ${JSON.stringify(mode)} === "invalid" ? "other" : request.params.type,
      data: { appended: ${JSON.stringify(mode)} !== "noop" } } }) + "\\n");
});
`,
  );
  const core = new WorkerBridgeCore({ entryPath, fallbackCwd: () => directory });
  cleanups.push(async () => {
    await core.stopAndWait();
    rmSync(directory, { recursive: true, force: true });
  });
  return { core, directory };
}

test("cold startup archive query without worker ownership is dropped until its deadline", async () => {
  const { core } = fixture();
  const outcome = await core.request(
    "agent/query",
    {
      type: "archive_marker",
      sessionId: "fixture-session",
      summary: "fixture summary",
      toClientMessageId: "fixture-boundary",
    },
    {
      id: "fixture-request",
      timeoutMs: 25,
      meta: { origin: "host", producer: "pet-context-migration" },
    },
  );
  expect(outcome).toEqual({ status: "timeout" });
  expect(core.hasLiveWorker()).toBe(false);
});

test("a host-owned archive query can start the worker without a model turn", async () => {
  const { core, directory } = fixture();
  expect(await requestStartupArchiveMarker(core, marker, directory, 1_000)).toBe(true);
  const generation = core.workerGeneration();
  expect(await requestStartupArchiveMarker(core, marker, directory, 1_000)).toBe(true);
  expect(core.workerGeneration()).toBe(generation);
  const requests = readFileSync(join(directory, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests).toEqual([
    { method: "agent/query", type: "archive_marker", cwd: directory },
    { method: "agent/query", type: "archive_marker", cwd: directory },
  ]);
});

test("unknown Session roots cannot launch a maintenance worker", async () => {
  const { core } = fixture();
  await expect(requestStartupArchiveMarker(core, marker, undefined)).rejects.toThrow(
    "Session root is unavailable",
  );
  expect(core.hasLiveWorker()).toBe(false);
});

test("an idempotent migration is a successful no-op", async () => {
  const { core, directory } = fixture("noop");
  expect(await requestStartupArchiveMarker(core, marker, directory, 1_000)).toBe(false);
});

test.each([
  ["exit", "Archive marker worker workerExit"],
  ["error", "fixture Session is closed"],
  ["invalid", "Archive marker worker returned an invalid result"],
] as const)(
  "a %s response settles maintenance without retrying a model turn",
  async (mode, error) => {
    const { core, directory } = fixture(mode);
    await expect(requestStartupArchiveMarker(core, marker, directory, 1_000)).rejects.toThrow(
      error,
    );
  },
);

test("an unanswered maintenance query retains a bounded deadline", async () => {
  const { core, directory } = fixture("never");
  await expect(requestStartupArchiveMarker(core, marker, directory, 100)).rejects.toThrow(
    "Archive marker worker timeout",
  );
});

test("an immediate write failure fails fast instead of waiting for the deadline", async () => {
  const { directory } = fixture();
  const core = new WorkerBridgeCore({
    entryPath: join(directory, "worker.cjs"),
    prepareInbound: () => {
      throw new Error("fixture write failed");
    },
  });
  cleanups.unshift(() => core.stopAndWait());
  await expect(requestStartupArchiveMarker(core, marker, directory, 30_000)).rejects.toThrow(
    "Archive marker worker sendFailed",
  );
  expect(core.hasLiveWorker()).toBe(false);
});
