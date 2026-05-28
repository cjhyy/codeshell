import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  assertSafeSessionId,
} from "../packages/core/src/session/session-manager.js";
import { SessionError } from "../packages/core/src/exceptions.js";

/**
 * Task 4 — session IDs reach filesystem paths via SessionManager.{create,
 * resume, exists, saveState}. An externally supplied ID must be a safe
 * basename. Internally generated nanoid IDs are trusted by construction
 * and continue to pass.
 */

describe("assertSafeSessionId", () => {
  const invalid: Array<[string, string]> = [
    ["empty string", ""],
    ["absolute path", "/tmp/x"],
    ["windows absolute path", "C:\\Windows\\Temp"],
    ["forward slash subpath", "a/b"],
    ["backslash subpath", "a\\b"],
    ["lone parent-dir", ".."],
    ["lone current-dir", "."],
    ["traversal", "../../etc/passwd"],
    ["embedded ..", "a..b"], // conservative — avoid the foot-gun entirely
    ["null byte", "abc\0def"],
    ["newline", "abc\ndef"],
    ["shell metachar", "a;b"],
    ["pipe", "a|b"],
    ["glob *", "*"],
    ["glob ?", "a?b"],
    ["space", "a b"],
    ["very long", "a".repeat(129)],
  ];

  for (const [name, value] of invalid) {
    test(`rejects ${name}`, () => {
      expect(() => assertSafeSessionId(value)).toThrow(SessionError);
    });
  }

  const valid = [
    "abc123",
    "tui-main",
    "agent.foo",
    "session_with_underscores",
    "a", // single char
    "0", // numeric
    "a.b-c_d",
    "A1B2C3D4E5F6G7H8", // 16-char nanoid shape
    "a".repeat(128), // boundary
  ];

  for (const id of valid) {
    test(`accepts "${id}"`, () => {
      expect(() => assertSafeSessionId(id)).not.toThrow();
    });
  }

  test("rejects non-string inputs", () => {
    expect(() => assertSafeSessionId(undefined as unknown as string)).toThrow(SessionError);
    expect(() => assertSafeSessionId(null as unknown as string)).toThrow(SessionError);
    expect(() => assertSafeSessionId(123 as unknown as string)).toThrow(SessionError);
  });
});

describe("SessionManager — public APIs enforce validation", () => {
  let storageDir: string;
  let mgr: SessionManager;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "codeshell-session-validation-"));
    mgr = new SessionManager(storageDir);
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("create() with traversal-shaped explicitSessionId throws", () => {
    expect(() => mgr.create("/tmp", "claude-opus-4-7", "anthropic", "../escape")).toThrow(SessionError);
  });

  test("create() with empty explicitSessionId throws", () => {
    expect(() => mgr.create("/tmp", "claude-opus-4-7", "anthropic", "")).toThrow(SessionError);
  });

  test("create() with no explicitSessionId uses generated nanoid and succeeds", () => {
    const bundle = mgr.create("/tmp", "claude-opus-4-7", "anthropic");
    expect(bundle.state.sessionId.length).toBe(16);
    // Must round-trip through resume() too.
    const resumed = mgr.resume(bundle.state.sessionId);
    expect(resumed.state.sessionId).toBe(bundle.state.sessionId);
  });

  test("create() with a safe explicit id like 'tui-main' succeeds", () => {
    const bundle = mgr.create("/tmp", "claude-opus-4-7", "anthropic", "tui-main");
    expect(bundle.state.sessionId).toBe("tui-main");
  });

  test("resume() rejects traversal", () => {
    expect(() => mgr.resume("../etc/passwd")).toThrow(SessionError);
  });

  test("exists() returns false for traversal-shaped ids (does not touch fs)", () => {
    // The probe form swallows the validation error and just reports "not
    // present" — this is the right shape for ChatSessionManager-style code
    // that uses exists() to choose between resume vs create.
    expect(mgr.exists("../etc/passwd")).toBe(false);
    expect(mgr.exists("/tmp/x")).toBe(false);
    expect(mgr.exists("")).toBe(false);
  });

  test("exists() still reports true for a real session", () => {
    const bundle = mgr.create("/tmp", "claude-opus-4-7", "anthropic", "real-sid");
    expect(mgr.exists("real-sid")).toBe(true);
    expect(mgr.exists(bundle.state.sessionId)).toBe(true);
  });

  test("saveState() rejects a tampered state.sessionId", () => {
    // Simulate a state.json on disk whose sessionId has been edited to
    // contain a traversal sequence.
    const tampered = {
      sessionId: "../poison",
      cwd: "/tmp",
      startedAt: Date.now(),
      model: "claude-opus-4-7",
      provider: "anthropic",
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      turnCount: 0,
      invokedSkills: [],
      status: "active" as const,
    };
    expect(() => mgr.saveState(tampered)).toThrow(SessionError);
  });
});
