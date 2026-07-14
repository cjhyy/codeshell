import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../context.js";
import { delegateWorkTool, delegateWorkToolDefFor } from "./delegate-work.js";

function context() {
  const recorded: Array<{ workspaceId: string; objective: string }> = [];
  const ctx = {
    petWorkspaces: [
      { id: "workspace-a", name: "Alpha", description: "/work/alpha" },
      { id: "workspace-b", name: "Beta", description: "/work/beta" },
    ],
    requestPetWorkDelegation: (request: { workspaceId: string; objective: string }) => {
      if (recorded.length > 0) return { ok: false, error: "only one delegation is allowed" };
      recorded.push(request);
      return { ok: true };
    },
  } as unknown as ToolContext;
  return { ctx, recorded };
}

describe("DelegateWork", () => {
  test("builds a closed Workspace enum and records an exact structured selection", async () => {
    const { ctx, recorded } = context();
    const definition = delegateWorkToolDefFor(ctx.petWorkspaces);
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
