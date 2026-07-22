import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import { mobileRemoteTool, mobileRemoteToolDef } from "./mobile-remote.js";

function context() {
  const recorded: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    runScopedServices: {
      requestPetHostAction: (request: { kind: string; payload: Record<string, unknown> }) => {
        if (recorded.some((existing) => existing.kind === request.kind)) {
          return { ok: false, error: "only one mobileRemote request is allowed per Mimi turn" };
        }
        recorded.push(request);
        return { ok: true };
      },
    },
  } as unknown as ToolContext;
  return { ctx, recorded };
}

describe("MobileRemote tool", () => {
  test("records a structured open request exactly once per turn", async () => {
    const { ctx, recorded } = context();

    expect(await mobileRemoteTool({ action: "open" }, ctx)).toContain("accepted");
    expect(recorded).toEqual([{ kind: "mobileRemote", payload: { action: "open" } }]);
    expect(await mobileRemoteTool({ action: "open" }, ctx)).toContain(
      "only one mobileRemote request",
    );
  });

  test("records a close request and rejects unknown actions", async () => {
    const { ctx, recorded } = context();

    expect(await mobileRemoteTool({ action: "shutdown" }, ctx)).toContain("Error");
    expect(recorded).toEqual([]);
    expect(await mobileRemoteTool({ action: "close" }, ctx)).toContain("accepted");
    expect(recorded).toEqual([{ kind: "mobileRemote", payload: { action: "close" } }]);
  });

  test("fails closed outside a Mimi manager turn", async () => {
    await expect(
      mobileRemoteTool({ action: "open" }, { runScopedServices: {} } as unknown as ToolContext),
    ).resolves.toContain("available only in a Mimi manager turn");
  });

  test("declares a closed action enum", () => {
    const action = (
      mobileRemoteToolDef.inputSchema.properties as Record<string, { enum?: string[] }>
    ).action;
    expect(action?.enum).toEqual(["open", "close"]);
    expect(mobileRemoteToolDef.inputSchema.additionalProperties).toBe(false);
  });
});
