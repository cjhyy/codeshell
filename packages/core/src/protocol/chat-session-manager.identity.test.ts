/**
 * Identity dimension foundations (Task 2): ChatSessionManager identity scope.
 *
 * - default identity is "local" and appears in the live snapshot;
 * - forIdentity() derives an isolated sibling whose engineFactory slices carry
 *   the per-identity session persistence root `<dataRoot>/identities/<id>/sessions`;
 * - asking for the manager's own identity returns the same instance (the
 *   default single-identity path stays byte-for-byte unchanged);
 * - path-hostile identities are rejected before any filesystem join.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatSessionManager,
  createChatSessionManager,
  LOCAL_CHAT_IDENTITY,
  type EngineConfigSlice,
} from "./chat-session-manager.js";
import type { Engine, EngineResult } from "../engine/engine.js";

function makeFakeEngine(): Engine {
  return {
    setAskUser() {},
    isHeadless: () => true,
    sessionExistsOnDisk: () => false,
    async run(): Promise<EngineResult> {
      return {
        text: "ok",
        reason: "completed",
        sessionId: "s",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
}

describe("ChatSessionManager identity scope", () => {
  it("defaults to the local identity and stamps it on snapshots", () => {
    const manager = createChatSessionManager({
      runtime: {} as never,
      engineFactory: () => makeFakeEngine(),
    });
    expect(manager.identity).toBe(LOCAL_CHAT_IDENTITY);
    expect(manager.getLiveSessionSnapshot().identity).toBe("local");
  });

  it("forIdentity(ownIdentity) returns the same instance (default path unchanged)", () => {
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => makeFakeEngine(),
    });
    expect(manager.forIdentity("local")).toBe(manager);
  });

  it("forIdentity derives a manager that injects the per-identity sessions root", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "csh-identity-"));
    try {
      const slices: EngineConfigSlice[] = [];
      const base = new ChatSessionManager({
        runtime: {} as never,
        engineFactory: (slice) => {
          slices.push(slice);
          return makeFakeEngine();
        },
        dataRoot,
      });

      const derived = base.forIdentity("user-a");
      expect(derived).not.toBe(base);
      expect(derived.identity).toBe("user-a");
      expect(derived.getLiveSessionSnapshot().identity).toBe("user-a");

      await derived.getOrCreate("sid-1", { cwd: "/tmp" } as EngineConfigSlice);
      expect(slices).toHaveLength(1);
      expect(slices[0]!.sessionStorageDir).toBe(
        join(dataRoot, "identities", "user-a", "sessions"),
      );
      // The base manager never saw the session — identities are isolated maps.
      expect(base.get("sid-1")).toBeUndefined();
      expect(derived.get("sid-1")).toBeDefined();

      // Base-manager sessions keep today's slices: no sessionStorageDir.
      await base.getOrCreate("sid-2", { cwd: "/tmp" } as EngineConfigSlice);
      expect(slices).toHaveLength(2);
      expect(slices[1]!.sessionStorageDir).toBeUndefined();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("rejects path-hostile identities", () => {
    const base = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => makeFakeEngine(),
    });
    for (const bad of ["../evil", "a/b", "a\\b", "..", "", "with space", "x".repeat(65)]) {
      expect(() => base.forIdentity(bad)).toThrow(/invalid identity/);
    }
  });
});
