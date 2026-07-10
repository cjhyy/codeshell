import { describe, expect, test } from "bun:test";
import { resolveAttachmentSessionId } from "./attachmentSession";
import type { SessionSummary } from "./transcripts";

function session(extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "ui-session",
    title: "test",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

describe("resolveAttachmentSessionId", () => {
  test("uses the bound engine session id for legacy UI sessions", () => {
    expect(
      resolveAttachmentSessionId("ui-session", [session({ engineSessionId: "engine-session" })]),
    ).toBe("engine-session");
  });

  test("falls back to the UI session id before an engine binding exists", () => {
    expect(resolveAttachmentSessionId("ui-session", [session()])).toBe("ui-session");
  });

  test("keeps a draft unresolved until attachment staging creates a session", () => {
    expect(resolveAttachmentSessionId(null, [])).toBeUndefined();
  });
});
