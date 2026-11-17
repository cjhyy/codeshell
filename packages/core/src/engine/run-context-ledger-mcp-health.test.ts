import { expect, test } from "bun:test";
import { Transcript } from "../session/transcript.js";
import { formatMcpConnectionFailures } from "../tool-system/mcp-health.js";
import { createRunContextLedger, engineContextSections } from "./run-context-ledger.js";

test("MCP ledger status stays valid until a recovery update supersedes it", () => {
  const transcript = Transcript.inMemory("mcp-ledger-status");
  transcript.appendMessage("user", "inspect the available tools");
  const messages = transcript.toMessages();
  const failures = new Map([["offline-server", "connection failed"]]);
  const sync = (state: ReadonlyMap<string, string>) =>
    createRunContextLedger({
      transcript,
      sessionId: "mcp-ledger-status",
      sections: engineContextSections({ mcpFailureSummary: formatMcpConnectionFailures(state) }),
    }).sync(messages);

  sync(failures);
  const snapshot = transcript.getEvents("message").at(-1)!;
  expect(snapshot.data.contextLedger).toMatchObject({ kind: "snapshot" });
  expect(snapshot.data.content).toContain(
    "currently unavailable; an update will follow if this changes",
  );
  expect(snapshot.data.content).not.toContain("this run");
  sync(failures);
  expect(transcript.getEvents("message")).toHaveLength(2);
  sync(new Map());
  const update = transcript.getEvents("message").at(-1)!;
  expect(update.data.contextLedger).toMatchObject({ kind: "update" });
  expect(update.data.content).toContain('<context-section-removed key="mcp-failures" />');
  expect(transcript.toMessages()).toEqual(messages);
  expect(messages[1]!.content).toBe(snapshot.data.content);
});
