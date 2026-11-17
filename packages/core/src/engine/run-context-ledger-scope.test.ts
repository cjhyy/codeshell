import { describe, expect, test } from "bun:test";
import type { ContextSection } from "../context/context-ledger.js";
import { Transcript } from "../session/transcript.js";
import type { Message } from "../types.js";
import { createRunContextLedger } from "./run-context-ledger.js";

const memory = (text: string): ContextSection[] => [{ key: "memory", text }];

function run(transcript: Transcript, sections: ContextSection[], scope?: string): Message[] {
  const messages = transcript.toMessages();
  messages.push({ role: "user", content: "task" });
  createRunContextLedger({ transcript, sections, scope }).sync(messages);
  return messages;
}

describe("context ledger scope", () => {
  test("a chain without a recorded scope is never revoked", () => {
    const transcript = Transcript.inMemory("ledger-scope-legacy");
    run(transcript, memory("OLD_FACT"));
    const messages = run(transcript, memory("OLD_FACT"), "workspace-b");
    expect(JSON.stringify(messages)).toContain("OLD_FACT");
    expect(transcript.getEvents("message").filter((e) => e.data.contextLedger)).toHaveLength(1);
  });

  test("revoking with nothing to tell leaves a content-less marker replay skips", () => {
    const transcript = Transcript.inMemory("ledger-scope-empty");
    run(transcript, memory("OLD_FACT"), "workspace-a");
    const messages = run(transcript, [], "workspace-b");
    expect(JSON.stringify(messages)).not.toContain("OLD_FACT");
    const replay = transcript.toMessages();
    expect(JSON.stringify(replay)).not.toContain("OLD_FACT");
    expect(replay.some((message) => message.content === "")).toBe(false);
    // The next run in the new workspace tells its context as a first snapshot.
    const next = run(transcript, memory("NEW_FACT"), "workspace-b");
    expect(JSON.stringify(next)).toContain("NEW_FACT");
    expect(JSON.stringify(next)).not.toContain("OLD_FACT");
  });

  test("the same scope never revokes", () => {
    const transcript = Transcript.inMemory("ledger-scope-same");
    run(transcript, memory("FACT"), "workspace-a");
    const messages = run(transcript, memory("FACT"), "workspace-a");
    expect(JSON.stringify(messages)).toContain("FACT");
    expect(transcript.getEvents("message").filter((e) => e.data.contextLedger)).toHaveLength(1);
  });
});
