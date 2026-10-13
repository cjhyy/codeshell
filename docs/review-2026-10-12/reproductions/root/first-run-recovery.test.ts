import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// This reproduction is offline. Install the guard before loading host/client code.
globalThis.fetch = (async () => {
  throw new Error("Review fixture forbids network requests");
}) as typeof fetch;
const { HubRunReplay } = await import("../../../../packages/server/src/hub/run-replay.ts");
const { chatFromOutputJournal } = await import("../../../../packages/web/app/chat.ts");

test("actual first-run Hub response has a healthy journal but fails the production recovery contract", async () => {
  const { data } = JSON.parse(
    readFileSync(new URL("./active-snapshot-journal.json", import.meta.url), "utf8"),
  );
  expect(data.running).toBe(true);
  expect(data.outputJournal.status).toBe("ok");
  expect(data.legacyBaseComplete).toBe(true);
  expect(data.outputJournal.legacyBaseThroughEventId).toBeTruthy();
  expect(data.transcript).toEqual([]);
  await expect(chatFromOutputJournal(data, async () => data.outputJournal, [])).rejects.toThrow(
    "Output recovery has no complete legacy base",
  );
});

test("a zero pre-run baseline strips a legacy anchor created by the first worker run", () => {
  const replay = new HubRunReplay();
  replay.begin("fresh-session", "first-request", 0);
  const legacy = [{ type: "session_meta", id: "journal-base" }];
  replay.append("fresh-session", {
    type: "session_user_message",
    text: "first task",
    clientMessageId: "first-intent",
  });
  expect(replay.snapshot("fresh-session", legacy).transcript).toEqual([]);
  replay.finish("fresh-session", "first-request");
  expect(replay.snapshot("fresh-session", legacy).transcript).toEqual(legacy);
});
