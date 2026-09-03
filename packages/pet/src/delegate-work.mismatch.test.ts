import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import { delegateWorkTool } from "./delegate-work.js";
import { PET_SYSTEM_PROMPT } from "./profile.js";

/**
 * Regression cover for a real loop: Mimi picked the no-workspace Workspace but
 * kept a session_id from another project. The host correctly refused, but the
 * refusal said only "does not belong", so the model had no action to take and
 * re-sent the identical pair.
 */

const WORKSPACES = [
  { id: "ws-no-workspace", name: "no-workspace", path: "/tmp/no-workspace" },
  { id: "ws-coding", name: "coding-learning", path: "/repo/coding-learning" },
];

const SESSIONS = [{ id: "sess-old", name: "旧的编码会话", workspaceId: "ws-coding" }];

function context(): { ctx: ToolContext; accepted: unknown[] } {
  const accepted: unknown[] = [];
  const ctx = {
    runScopedServices: {
      petWorkspaces: WORKSPACES,
      petReusableSessions: SESSIONS,
      requestPetWorkDelegation: (request: unknown) => {
        accepted.push(request);
        return { ok: true };
      },
    },
  } as unknown as ToolContext;
  return { ctx, accepted };
}

describe("a session_id paired with the wrong workspace_id", () => {
  test("is refused without starting any work", async () => {
    const { ctx, accepted } = context();
    const result = await delegateWorkTool(
      { workspace_id: "ws-no-workspace", objective: "继续修登录", session_id: "sess-old" },
      ctx,
    );
    expect(result).toStartWith("Error:");
    expect(accepted).toEqual([]);
  });

  test("names both Workspaces so the model can tell them apart", async () => {
    const { ctx } = context();
    const result = await delegateWorkTool(
      { workspace_id: "ws-no-workspace", objective: "继续修登录", session_id: "sess-old" },
      ctx,
    );
    expect(result).toContain("ws-coding");
    expect(result).toContain("ws-no-workspace");
  });

  test("states both ways out and forbids resending the same pair", async () => {
    // Without this the model repeats the identical arguments forever.
    const { ctx } = context();
    const result = await delegateWorkTool(
      { workspace_id: "ws-no-workspace", objective: "继续修登录", session_id: "sess-old" },
      ctx,
    );
    expect(result).toContain("Do not send this pair again");
    expect(result).toContain("omit session_id");
    expect(result).toContain("workspace_id");
  });

  test("the corrected call succeeds: dropping session_id starts a new Session", async () => {
    // The rejection must not consume the turn's single delegation.
    const { ctx, accepted } = context();
    await delegateWorkTool(
      { workspace_id: "ws-no-workspace", objective: "继续修登录", session_id: "sess-old" },
      ctx,
    );
    const retry = await delegateWorkTool(
      { workspace_id: "ws-no-workspace", objective: "继续修登录" },
      ctx,
    );
    expect(retry).not.toStartWith("Error:");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ workspaceId: "ws-no-workspace" });
    expect(accepted[0]).not.toHaveProperty("reusableSessionId");
  });

  test("the other correction also succeeds: switching to the owning Workspace", async () => {
    const { ctx, accepted } = context();
    await delegateWorkTool(
      { workspace_id: "ws-no-workspace", objective: "继续修登录", session_id: "sess-old" },
      ctx,
    );
    const retry = await delegateWorkTool(
      { workspace_id: "ws-coding", objective: "继续修登录", session_id: "sess-old" },
      ctx,
    );
    expect(retry).not.toStartWith("Error:");
    expect(accepted[0]).toMatchObject({
      workspaceId: "ws-coding",
      reusableSessionId: "sess-old",
    });
  });
});

describe("an unknown session_id", () => {
  test("tells the model to drop it rather than guess another", async () => {
    const { ctx, accepted } = context();
    const result = await delegateWorkTool(
      { workspace_id: "ws-coding", objective: "继续", session_id: "sess-imagined" },
      ctx,
    );
    expect(result).toStartWith("Error:");
    expect(result).toContain("Do not send it again");
    expect(result).toContain("Omit session_id");
    expect(accepted).toEqual([]);
  });
});

describe("the prompt rule behind the loop", () => {
  test("states that a Session belongs to one Workspace and repeats are wrong", () => {
    expect(PET_SYSTEM_PROMPT).toContain("belongs to exactly one Workspace");
    expect(PET_SYSTEM_PROMPT).toContain("Repeating identical rejected arguments is always wrong");
  });
});
