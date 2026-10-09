import { expect, test } from "bun:test";
import { OutputCoverage } from "./output-coverage.js";
import { SessionSnapshotStore } from "./SessionSnapshotStore.js";
const cursorAt = (sequence: number) =>
  Buffer.from(
    JSON.stringify({
      identity: "a".repeat(64),
      hash: "b".repeat(64),
      sequence,
      offset: sequence * 100,
    }),
  ).toString("base64url");
const cursor = cursorAt(1);

test("invalid cursors and child starts cannot erase a missing visible event", () => {
  for (const invalid of ["", "bad!", "x".repeat(2049), 1]) {
    const proof = new OutputCoverage();
    proof.observe({ type: "text_delta", outputCursor: invalid });
    proof.observe({ type: "session_started", runId: "new", outputCursor: cursor });
    expect(proof.incomplete).toBe(true);
  }
  const proof = new OutputCoverage();
  proof.observe({ type: "error", message: "missing" });
  proof.observe({
    type: "session_started",
    runId: "child",
    agentId: "child",
    outputCursor: cursor,
  });
  expect(proof.incomplete).toBe(true);
});

test("neither repeated nor new recorded runs erase uncovered visible state", () => {
  const proof = new OutputCoverage();
  proof.observe({ type: "session_started", runId: "run-1", outputCursor: cursor });
  proof.observe({ type: "goal_updated" });
  proof.observe({ type: "session_started", runId: "run-1", outputCursor: cursorAt(2) });
  expect(proof.incomplete).toBe(true);
  proof.observe({ type: "session_started", runId: "run-2", outputCursor: cursorAt(3) });
  expect(proof.incomplete).toBe(true);
});

test("proof storage stays bounded after RAM eviction, overflow never forgets missing identities", () => {
  const store = new SessionSnapshotStore({ maxPerSession: 1 });
  for (let index = 0; index < 129; index++)
    store.append("s", { type: "session_user_message", clientMessageId: `input-${index}` });
  expect(store.get("s").events).toHaveLength(1);
  expect(store.get("s").outputInputIds).toBeUndefined();
  expect(store.get("s").outputUnpaired).toBe(true);
  store.append("s", { type: "session_started", runId: "new", outputCursor: cursor });
  expect(store.get("s").outputUnpaired).toBe(true);
});

test("global identity budget rejects new proof without evicting existing sessions' proof", () => {
  const store = new SessionSnapshotStore({ maxPerSession: 1 });
  const fill = (session: string) => {
    for (let index = 0; index < 64; index++)
      store.append(session, {
        type: "session_user_message",
        clientMessageId: `${index}`.padEnd(512, "x"),
      });
  };
  for (let index = 0; index < 128; index++) fill(`s-${index}`);
  fill("overflow");
  expect(store.get("s-0").outputInputIds).toHaveLength(64);
  expect(store.get("overflow").outputUnpaired).toBe(true);
  expect(store.get("overflow").outputInputIds).toBeUndefined();
  store.forget("s-0");
  fill("after-forget");
  expect(store.get("after-forget").outputInputIds).toHaveLength(64);
  expect(store.get("after-forget").outputUnpaired).toBeUndefined();
});
