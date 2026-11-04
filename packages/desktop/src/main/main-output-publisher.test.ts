import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type StreamEvent } from "@cjhyy/code-shell-core";
import { SessionOutputJournal } from "@cjhyy/code-shell-core/internal";
import { captureIdleOutputPrefix, MainOutputPublisher } from "./main-output-publisher.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "main-output-cold-"));
  roots.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "test", "test", "session");
  manager.startSessionRun(session.state, "run");
  const writer = new SessionOutputJournal(root, "session", "run");
  for (let batch = 0; batch < 8; batch++)
    writer.appendBatch(Array.from({ length: 64 }, () => ({ type: "text_delta", text: "old" })));
  const applied: StreamEvent[] = [];
  let latest: string | undefined;
  const apply = (event: StreamEvent) => {
    latest = event.outputCursor;
    applied.push(event);
    return true;
  };
  const publisher = new MainOutputPublisher({
    root: () => root,
    latest: () => latest,
    worker: (_id, event) => apply(event),
  });
  return { root, writer, publisher, applied, apply };
}

test("a cold idle host failure publishes only its newly captured suffix", () => {
  const f = fixture();
  const prefix = captureIdleOutputPrefix(f.root, "session", { topLevelRunning: false }, false);
  expect(prefix).toBeDefined();
  const source = f.publisher.capture(
    "session",
    (event) => f.apply(event as StreamEvent),
    undefined,
    prefix,
  );
  const event = { type: "text_delta" as const, text: "after capture" };
  const cursor = f.writer.append(event);
  source.publish({ type: "error", error: "Panel submission rejected" });
  expect(f.applied.map((event) => event.type)).toEqual(["text_delta", "error"]);
  expect(f.applied[0]).toMatchObject({ text: "after capture", outputCursor: cursor });
  // The late live notification of that NEW suffix is still deduplicated.
  expect(f.publisher.observeWorker("session", { ...event, outputCursor: cursor })).toBe(false);
});

test("a submitted worker or an already-running Main Session cannot skip unseen output", () => {
  const f = fixture();
  expect(
    captureIdleOutputPrefix(f.root, "session", { topLevelRunning: false }, true),
  ).toBeUndefined();
  expect(
    captureIdleOutputPrefix(f.root, "session", { topLevelRunning: true }, false),
  ).toBeUndefined();
  const source = f.publisher.capture("session", (event) => f.apply(event as StreamEvent));
  source.publish({ type: "error", error: "active producer failed" });
  expect(f.applied.filter((event) => event.type === "text_delta")).toHaveLength(512);
});
