import { describe, expect, test } from "bun:test";
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
