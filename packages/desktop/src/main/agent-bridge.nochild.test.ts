// packages/desktop/src/main/agent-bridge.nochild.test.ts
//
// When the worker subprocess is not live (aborted / recycled between sessions),
// the bridge must still ANSWER read-only / disk-backed JSON-RPC requests, or
// the renderer's rpc() promise hangs (30s timeout) and the UI never updates.
//
// The regression this guards: agent/goalClear and agent/goalGet were dropped
// silently with no reply, so the "Clear goal" button did nothing for an
// aborted goal session (worker already exited) — the persistent goal lives
// only in state.json and could never be cleared from the UI.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import {
  buildNoChildFallbackReply,
  compactQuerySessionId,
  forkSourceSessionId,
  quickChatForkRequest,
} from "./agent-bridge-fallback.js";

describe("buildNoChildFallbackReply — no live worker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sm(): SessionManager {
    return new SessionManager(dir);
  }

  test("agent/goalClear on a session WITH a goal clears it and replies cleared:true", () => {
    const m = sm();
    const { state } = m.create("/p", "gpt-5.5", "openai", "s-1");
    state.activeGoal = { objective: "干到4点" };
    m.saveState(state);

    const reply = buildNoChildFallbackReply(
      { id: 9, method: "agent/goalClear", params: { sessionId: "s-1" } },
      m,
    );
    expect(reply).not.toBeNull();
    const parsed = JSON.parse(reply!);
    expect(parsed.id).toBe(9);
    expect(parsed.result).toEqual({ ok: true, cleared: true });
    // And the goal is actually gone from disk.
    expect(m.readActiveGoal("s-1")).toBeUndefined();
  });

  test("agent/goalClear on a session with NO goal replies cleared:false", () => {
    const m = sm();
    m.create("/p", "gpt-5.5", "openai", "s-2");
    const reply = buildNoChildFallbackReply(
      { id: 10, method: "agent/goalClear", params: { sessionId: "s-2" } },
      m,
    );
    expect(JSON.parse(reply!).result).toEqual({ ok: true, cleared: false });
  });

  test("agent/goalGet returns the goal objective off disk", () => {
    const m = sm();
    const { state } = m.create("/p", "gpt-5.5", "openai", "s-3");
    state.activeGoal = { objective: "找问题挖细节" };
    m.saveState(state);
    const reply = buildNoChildFallbackReply(
      { id: 11, method: "agent/goalGet", params: { sessionId: "s-3" } },
      m,
    );
    expect(JSON.parse(reply!).result).toEqual({ ok: true, goal: "找问题挖细节" });
  });

  test("agent/goalGet with no goal replies goal:null", () => {
    const m = sm();
    m.create("/p", "gpt-5.5", "openai", "s-4");
    const reply = buildNoChildFallbackReply(
      { id: 12, method: "agent/goalGet", params: { sessionId: "s-4" } },
      m,
    );
    expect(JSON.parse(reply!).result).toEqual({ ok: true, goal: null });
  });

  test("existing background-work fallback still answers empty", () => {
    const reply = buildNoChildFallbackReply(
      { id: 13, method: "agent/backgroundWork", params: {} },
      sm(),
    );
    expect(JSON.parse(reply!).result).toEqual({ items: [] });
  });

  test("a request with no id is not answered (notification-style)", () => {
    const reply = buildNoChildFallbackReply(
      { method: "agent/goalClear", params: { sessionId: "s-1" } },
      sm(),
    );
    expect(reply).toBeNull();
  });

  test("methods that legitimately drop (cancel/approve) return null", () => {
    expect(
      buildNoChildFallbackReply({ id: 1, method: "agent/cancel", params: {} }, sm()),
    ).toBeNull();
    expect(
      buildNoChildFallbackReply({ id: 2, method: "agent/approve", params: {} }, sm()),
    ).toBeNull();
  });

  test("goalClear without a sessionId returns null (nothing to clear)", () => {
    expect(
      buildNoChildFallbackReply({ id: 3, method: "agent/goalClear", params: {} }, sm()),
    ).toBeNull();
  });

  test("compact query is recognized as worker-spawning, not no-child fallback", () => {
    const parsed = {
      id: 4,
      method: "agent/query",
      params: { type: "compact", sessionId: "s-compact" },
    };

    expect(compactQuerySessionId(parsed)).toBe("s-compact");
    expect(buildNoChildFallbackReply(parsed, sm())).toBeNull();
  });
});

describe("forkSourceSessionId", () => {
  test("extracts only agent/forkSession source ids for cold-start routing", () => {
    expect(
      forkSourceSessionId({
        method: "agent/forkSession",
        params: { sourceSessionId: "source-session" },
      }),
    ).toBe("source-session");
    expect(
      forkSourceSessionId({ method: "agent/run", params: { sourceSessionId: "source-session" } }),
    ).toBeNull();
    expect(forkSourceSessionId({ method: "agent/forkSession", params: {} })).toBeNull();
  });

  test("extracts a quick-chat claim generation only from a tracked fork request", () => {
    expect(
      quickChatForkRequest(
        {
          id: 42,
          method: "agent/forkSession",
          params: {
            sourceSessionId: "source-session",
            targetSessionId: "qchat-target-1",
            quickChatClaimId: "generation-1",
          },
        },
        101,
      ),
    ).toEqual({
      requestId: 42,
      sessionId: "qchat-target-1",
      ownerId: 101,
      claimId: "generation-1",
    });
    expect(
      quickChatForkRequest(
        {
          id: 43,
          method: "agent/forkSession",
          params: { targetSessionId: "normal-session", quickChatClaimId: "generation-1" },
        },
        101,
      ),
    ).toBeNull();
    expect(
      quickChatForkRequest(
        { id: 44, method: "agent/forkSession", params: { targetSessionId: "qchat-target-2" } },
        101,
      ),
    ).toBeNull();
  });
});
