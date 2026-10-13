import { describe, expect, test } from "bun:test";
import { normalizeCloudNativeOrigin, validateCloudRequest } from "./cloud-native-policy";

describe("native cloud authority", () => {
  test("accepts only a canonical HTTPS or loopback origin", () => {
    expect(normalizeCloudNativeOrigin(" HTTPS://Example.com:443/ ")).toBe("https://example.com");
    expect(normalizeCloudNativeOrigin("http://127.0.0.1:8790/")).toBe("http://127.0.0.1:8790");
    for (const value of [
      "http://example.com",
      "https://user@example.com",
      "https://@example.com",
      "https://example.com/?project=x",
      "https://example.com/#",
      "https://example.com/../",
      "https://example.com/path",
      "https://example.com\\x",
      "file:///tmp",
    ]) {
      expect(() => normalizeCloudNativeOrigin(value)).toThrow();
    }
  });
  test("runs carry input intent but never local authority or host execution policy", () => {
    const params = { sessionId: "remote-session", task: "hello", clientMessageId: "intent-1" };
    expect(validateCloudRequest("agent/run", params).params).toEqual(params);
    for (const key of [
      "cwd",
      "projectId",
      "rootId",
      "workspaceContext",
      "projectTrusted",
      "sandboxMode",
      "allowBackgroundShells",
      "attachments",
      "quickChatClaimId",
      "browserPartition",
    ]) {
      expect(() =>
        validateCloudRequest("agent/run", { ...params, [key]: "/local/project" }),
      ).toThrow();
    }
    for (const method of ["agent/configure", "agent/steer", "agent/compact", "system/shutdown"]) {
      expect(() => validateCloudRequest(method, params)).toThrow();
    }
  });
  test("bounds history, approval, attachment IDs and explicit request shapes", () => {
    expect(
      validateCloudRequest("agent/query", {
        type: "session_detail",
        sessionId: "s",
        outputRecovery: true,
      }).method,
    ).toBe("agent/query");
    expect(validateCloudRequest("agent/query", { type: "sessions" }).params).toEqual({
      type: "sessions",
    });
    expect(
      validateCloudRequest("agent/approve", {
        sessionId: "s",
        requestId: "approval",
        decision: { approved: true, answer: "yes" },
      }).method,
    ).toBe("agent/approve");
    for (const [method, params] of [
      ["agent/query", { type: "settings" }],
      ["agent/query", { type: "sessions", cwd: "/tmp" }],
      ["agent/query", { type: "output_journal", sessionId: "s", maxBytes: 99_999_999 }],
      ["agent/cancel", { sessionId: "../session" }],
      [
        "agent/approve",
        { sessionId: "s", requestId: "r", connectionId: "spoof", decision: { approved: true } },
      ],
      [
        "agent/run",
        { sessionId: "s", task: "x", clientMessageId: "i", uploadIds: ["duplicate", "duplicate"] },
      ],
    ])
      expect(() => validateCloudRequest(method, params)).toThrow();
  });
  test("keeps existing dotted session IDs usable and rejects traversal in every session operation", () => {
    for (const sessionId of ["session.v1", "legacy-session.2026", "_old.1"]) {
      expect(
        validateCloudRequest("agent/query", { type: "session_detail", sessionId }).params.sessionId,
      ).toBe(sessionId);
      expect(validateCloudRequest("agent/cancel", { sessionId }).params.sessionId).toBe(sessionId);
      expect(
        validateCloudRequest("agent/run", {
          sessionId,
          task: "continue",
          clientMessageId: "intent",
        }).params.sessionId,
      ).toBe(sessionId);
    }
    for (const sessionId of [
      ".session",
      ".",
      "..",
      "session..v1",
      "../session",
      "session/../other",
      "session\\other",
    ]) {
      expect(() =>
        validateCloudRequest("agent/query", { type: "session_detail", sessionId }),
      ).toThrow();
      expect(() => validateCloudRequest("agent/cancel", { sessionId })).toThrow();
    }
  });
});
