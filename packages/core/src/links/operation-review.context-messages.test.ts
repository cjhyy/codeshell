import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyLinkOperationCandidates } from "./operation-review.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidates(contextEvents: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "link-review-context-"));
  roots.push(directory);
  const receipt = { id: "op-1", owner: "owner", fingerprint: "fp", attemptId: "attempt" };
  const args = { provider: "github", action: "create_issue", params: { title: "t" } };
  const events = [
    { type: "session_meta", data: { startedAt: 1, sessionId: "s-1" } },
    {
      type: "message",
      data: { role: "user", content: "file an issue", clientMessageId: "intent" },
    },
    ...contextEvents,
    { type: "tool_use", data: { toolName: "LinkAction", toolCallId: "call", args } },
    {
      type: "tool_result",
      data: {
        toolName: "LinkAction",
        toolCallId: "call",
        result: JSON.stringify({
          kind: "unverified_write",
          untrustedExternalContent: true,
          provider: "github",
          action: "create_issue",
          operation: receipt,
        }),
      },
    },
  ];
  writeFileSync(
    join(directory, "transcript.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return legacyLinkOperationCandidates(
    { incarnation: "i", binding: "b", startedAt: 1, state: { sessionId: "s-1" }, directory },
    receipt as never,
  );
}

test("engine context after the user message does not clear the originating intent", () => {
  const plain = candidates([]);
  expect(plain).toHaveLength(1);
  expect(plain[0]!.originIntent).toBe("intent");
  const withContext = candidates([
    {
      type: "message",
      data: {
        role: "user",
        injected: true,
        content: "<system-reminder>hook</system-reminder>",
        hookReminder: { sessionStart: ["hook"] },
      },
    },
    {
      type: "message",
      data: {
        role: "user",
        injected: true,
        content: "<system-reminder>context</system-reminder>",
        contextLedger: { kind: "snapshot", state: "{}" },
      },
    },
  ]);
  expect(withContext).toEqual(plain);
});
