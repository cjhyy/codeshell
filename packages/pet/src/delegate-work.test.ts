import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import {
  delegateWorkAvailability,
  delegateWorkTool,
  delegateWorkToolDefFor,
} from "./delegate-work.js";
import { validatePetRunParams } from "./projection-extension.js";

const WORKSPACES = [
  { id: "workspace-a", name: "Alpha", description: "/work/alpha" },
  { id: "workspace-b", name: "Beta", description: "/work/beta" },
];

function context() {
  const recorded: Array<{ workspaceId: string; objective: string }> = [];
  const ctx = {
    runScopedServices: {
      petWorkspaces: WORKSPACES,
      requestPetWorkDelegation: (request: { workspaceId: string; objective: string }) => {
        if (recorded.length > 0) return { ok: false, error: "only one delegation is allowed" };
        recorded.push(request);
        return { ok: true };
      },
    },
  } as unknown as ToolContext;
  return { ctx, recorded };
}

describe("DelegateWork", () => {
  test("builds a closed Workspace enum and records an exact structured selection", async () => {
    const { ctx, recorded } = context();
    const definition = delegateWorkToolDefFor(WORKSPACES);
    const workspaceSchema = (
      definition.inputSchema.properties as Record<string, { enum?: string[] }>
    ).workspace_id;

    expect(workspaceSchema?.enum).toEqual(["workspace-a", "workspace-b"]);
    expect(
      await delegateWorkTool(
        { workspace_id: "workspace-b", objective: "  fix the login flow  " },
        ctx,
      ),
    ).toContain("Beta");
    expect(recorded).toEqual([{ workspaceId: "workspace-b", objective: "fix the login flow" }]);
  });

  test("rejects invented Workspace ids and a second delegation", async () => {
    const { ctx, recorded } = context();

    expect(
      await delegateWorkTool({ workspace_id: "invented", objective: "do work" }, ctx),
    ).toContain("unknown workspace_id");
    expect(recorded).toEqual([]);

    await delegateWorkTool({ workspace_id: "workspace-a", objective: "first" }, ctx);
    expect(
      await delegateWorkTool({ workspace_id: "workspace-b", objective: "second" }, ctx),
    ).toContain("only one delegation is allowed");
  });
});

describe("delegateWorkAvailability", () => {
  test("visible only for a Pet turn with host-provided Workspaces", () => {
    expect(
      delegateWorkAvailability({
        cwd: "/x",
        hasGoal: false,
        behaviorProfile: "pet",
        profileMeta: { petWorkspaces: [{ id: "workspace-a", name: "Alpha" }] },
      } as never),
    ).toBe(true);
    expect(
      delegateWorkAvailability({
        cwd: "/x",
        hasGoal: false,
        behaviorProfile: "pet",
        profileMeta: { petWorkspaces: [] },
      } as never),
    ).toBe(false);
    expect(
      delegateWorkAvailability({
        cwd: "/x",
        hasGoal: false,
        behaviorProfile: "quickChatRestricted",
      } as never),
    ).toBe(false);
  });
});

describe("validatePetRunParams", () => {
  test("does not claim behavior modes or session kinds owned by other extensions", () => {
    expect(validatePetRunParams({ behaviorMode: "review", kind: "review-session" })).toBeNull();
  });

  test("validates canonical profile params using Engine's override precedence", () => {
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        petRuntimeContext: '{"legacy":true}',
        profileParams: { runtimeContext: "not-json" },
      }),
    ).toBe("profileParams.runtimeContext must be valid JSON");

    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: {
          runtimeContext: '{"pending":[]}',
          workspaces: [{ id: "workspace-a", name: "Alpha" }],
        },
      }),
    ).toBeNull();
  });

  test("rejects malformed canonical workspaces", () => {
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: {
          workspaces: [
            { id: "duplicate", name: "One" },
            { id: "duplicate", name: "Two" },
          ],
        },
      }),
    ).toBe("profileParams.workspaces contains an invalid or duplicate Workspace");
  });
});
