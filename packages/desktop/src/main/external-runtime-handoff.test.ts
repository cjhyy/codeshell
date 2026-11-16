import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_CANARY,
  PUBLIC_PROMPT,
  PUBLIC_ANSWER,
  contextPrivacySession,
} from "../../../../tests/helpers/context-privacy.js";
import type { RawTranscriptEvent } from "./rawTranscript";
import { buildExternalRuntimeHandoffFromEvents } from "./external-runtime-handoff";

function event(
  role: string,
  content: unknown,
  data: Record<string, unknown> = {},
): RawTranscriptEvent {
  return {
    id: `${role}-${Math.random()}`,
    type: "message",
    timestamp: 1,
    turnNumber: 0,
    data: { role, content, ...data },
  };
}

describe("buildExternalRuntimeHandoffFromEvents", () => {
  test("projects canonical messages without leaking display-only text", () => {
    const handoff = buildExternalRuntimeHandoffFromEvents([
      event("user", "full task", { displayText: "short label" }),
      event("assistant", [{ type: "text", text: "done" }]),
      event("user", "background result", { injected: true }),
    ]);

    expect(handoff).toContain("USER: full task");
    expect(handoff).toContain("ASSISTANT: done");
    expect(handoff).toContain("SYSTEM NOTE: background result");
    expect(handoff).not.toContain("short label");
  });

  test("leaves out the engine's own context messages", () => {
    const handoff = buildExternalRuntimeHandoffFromEvents([
      event("user", "full task"),
      event("user", "<system-reminder>\nMEMORY INDEX\n</system-reminder>", {
        injected: true,
        contextLedger: { kind: "snapshot", state: "{}" },
      }),
      event("user", "<system-reminder>\nHOOK RULES\n</system-reminder>", {
        injected: true,
        hookReminder: { sessionStart: ["HOOK RULES"] },
      }),
      event("assistant", [{ type: "text", text: "done" }]),
    ]);

    expect(handoff).toContain("USER: full task");
    expect(handoff).toContain("ASSISTANT: done");
    expect(handoff).not.toContain("MEMORY INDEX");
    expect(handoff).not.toContain("HOOK RULES");
    expect(handoff).not.toContain("SYSTEM NOTE");
  });

  test("keeps only a bounded recent tail", () => {
    const handoff = buildExternalRuntimeHandoffFromEvents([
      ...Array.from({ length: 5 }, (_, index) =>
        event("user", `old-${index}-${"x".repeat(12_000)}`),
      ),
      event("user", `recent-${"y".repeat(11_000)}`),
    ]);

    expect(handoff).toContain("recent-");
    expect(handoff).not.toContain("old-0-");
    expect(handoff!.length).toBeLessThan(50_000);
  });
});

const privacyRoots: string[] = [];
afterEach(() => {
  for (const root of privacyRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("external handoff excludes rewritten NewContext snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-context-privacy-"));
  privacyRoots.push(root);
  const { bundle } = contextPrivacySession(root, root);
  const handoff = buildExternalRuntimeHandoffFromEvents(bundle.transcript.getEvents());
  expect(handoff).not.toContain(CONTEXT_CANARY);
  expect(handoff).toContain(PUBLIC_PROMPT);
  expect(handoff).toContain(PUBLIC_ANSWER);
  expect(JSON.stringify(bundle.transcript.toMessages())).toContain(`${CONTEXT_CANARY}:rewrite`);
});
