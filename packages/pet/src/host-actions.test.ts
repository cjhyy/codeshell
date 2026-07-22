import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import {
  CONTROL_LONG_TASK_TOOL_NAME,
  controlLongTaskAvailability,
  controlLongTaskTool,
  isPetHostActionRequest,
  MEMORY_TOOL_NAME,
  memoryAvailability,
  memoryTool,
} from "./host-actions.js";
import { mobileRemoteAvailability, mobileRemoteTool } from "./mobile-remote.js";
import { PET_ALLOWED_TOOL_NAMES, PET_BEHAVIOR_PROFILE } from "./profile.js";

function context() {
  const recorded: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const kinds = new Set<string>();
  const ctx = {
    runScopedServices: {
      requestPetHostAction: (request: { kind: string; payload: Record<string, unknown> }) => {
        if (kinds.has(request.kind)) {
          return {
            ok: false,
            error: `only one ${request.kind} request is allowed per Mimi turn`,
          };
        }
        kinds.add(request.kind);
        recorded.push(request);
        return { ok: true };
      },
    },
  } as unknown as ToolContext;
  return { ctx, recorded };
}

describe("ControlLongTask tool", () => {
  test("records a structured control request with a validated action", async () => {
    const { ctx, recorded } = context();

    expect(await controlLongTaskTool({ task_id: "pet-task-abc", action: "cancel" }, ctx)).toContain(
      "accepted",
    );
    expect(recorded).toEqual([
      { kind: "longTaskControl", payload: { taskId: "pet-task-abc", action: "cancel" } },
    ]);
  });

  test("rejects unknown actions and missing task ids without recording", async () => {
    const { ctx, recorded } = context();

    expect(await controlLongTaskTool({ task_id: "x", action: "destroy" }, ctx)).toContain("Error");
    expect(await controlLongTaskTool({ action: "cancel" }, ctx)).toContain("Error");
    expect(recorded).toEqual([]);
  });

  test("fails closed outside a Mimi manager turn", async () => {
    await expect(
      controlLongTaskTool({ task_id: "x", action: "cancel" }, {
        runScopedServices: {},
      } as unknown as ToolContext),
    ).resolves.toContain("available only in a Mimi manager turn");
  });
});

describe("Memory tool", () => {
  test("records remember/update/forget with bounded validated payloads", async () => {
    const first = context();
    expect(await memoryTool({ action: "remember", text: " 喜欢暗色主题 " }, first.ctx)).toContain(
      "accepted",
    );
    expect(first.recorded).toEqual([
      { kind: "memory", payload: { action: "remember", text: "喜欢暗色主题" } },
    ]);

    const second = context();
    expect(
      await memoryTool({ action: "update", memory_id: "mem-1", text: "新内容" }, second.ctx),
    ).toContain("accepted");
    expect(second.recorded).toEqual([
      { kind: "memory", payload: { action: "update", memoryId: "mem-1", text: "新内容" } },
    ]);

    const third = context();
    expect(await memoryTool({ action: "forget", memory_id: "mem-2" }, third.ctx)).toContain(
      "accepted",
    );
    expect(third.recorded).toEqual([
      { kind: "memory", payload: { action: "forget", memoryId: "mem-2" } },
    ]);
  });

  test("rejects invalid combinations without recording", async () => {
    const { ctx, recorded } = context();

    expect(await memoryTool({ action: "remember" }, ctx)).toContain("Error");
    expect(await memoryTool({ action: "update", text: "no id" }, ctx)).toContain("Error");
    expect(await memoryTool({ action: "forget" }, ctx)).toContain("Error");
    expect(await memoryTool({ action: "remember", text: "x".repeat(2_001) }, ctx)).toContain(
      "Error",
    );
    expect(recorded).toEqual([]);
  });
});

describe("host-action availability", () => {
  const meta = (kinds: string[]) =>
    ({
      cwd: "/x",
      hasGoal: false,
      behaviorProfile: "pet",
      profileMeta: { petHostActionKinds: kinds },
    }) as never;

  test("each tool is visible only when the host declared its kind", () => {
    expect(mobileRemoteAvailability(meta(["mobileRemote"]))).toBe(true);
    expect(mobileRemoteAvailability(meta(["memory"]))).toBe(false);
    expect(controlLongTaskAvailability(meta(["longTaskControl"]))).toBe(true);
    expect(controlLongTaskAvailability(meta([]))).toBe(false);
    expect(memoryAvailability(meta(["memory"]))).toBe(true);
    expect(memoryAvailability(meta(["mobileRemote", "longTaskControl"]))).toBe(false);
  });
});

describe("host-action envelope validation", () => {
  test("accepts only exact, bounded payloads for each host side effect", () => {
    expect(isPetHostActionRequest({ kind: "mobileRemote", payload: { action: "open" } })).toBe(
      true,
    );
    expect(
      isPetHostActionRequest({
        kind: "longTaskControl",
        payload: { taskId: "pet-task-1", action: "pause" },
      }),
    ).toBe(true);
    expect(
      isPetHostActionRequest({
        kind: "memory",
        payload: { action: "update", memoryId: "mem-1", text: "new text" },
      }),
    ).toBe(true);

    expect(isPetHostActionRequest({ kind: "mobileRemote", payload: { action: "destroy" } })).toBe(
      false,
    );
    expect(
      isPetHostActionRequest({
        kind: "longTaskControl",
        payload: { taskId: "../other", action: "cancel", injected: true },
      }),
    ).toBe(false);
    expect(
      isPetHostActionRequest({
        kind: "memory",
        payload: { action: "remember", text: "x".repeat(2_001) },
      }),
    ).toBe(false);
    expect(
      isPetHostActionRequest({
        kind: "memory",
        payload: { action: "forget", memoryId: "mem-1", text: "unexpected" },
      }),
    ).toBe(false);
    expect(
      isPetHostActionRequest({
        kind: "unknown",
        payload: {},
      }),
    ).toBe(false);
  });
});

describe("pet profile host-action integration", () => {
  test("allowlists the tools and reports one bounded request per kind per turn", () => {
    expect(PET_ALLOWED_TOOL_NAMES.has(CONTROL_LONG_TASK_TOOL_NAME)).toBe(true);
    expect(PET_ALLOWED_TOOL_NAMES.has(MEMORY_TOOL_NAME)).toBe(true);

    const reported: Array<{ key: string; value: unknown }> = [];
    const services = PET_BEHAVIOR_PROFILE.createRunServices!({
      profileParams: { hostActions: ["mobileRemote", "memory"] },
      reportResult: (key, value) => void reported.push({ key, value }),
    } as never) as {
      requestPetHostAction: (request: { kind: string; payload: Record<string, unknown> }) => {
        ok: boolean;
        error?: string;
      };
    };

    expect(
      services.requestPetHostAction({ kind: "mobileRemote", payload: { action: "open" } }),
    ).toEqual({ ok: true });
    expect(
      services.requestPetHostAction({
        kind: "memory",
        payload: { action: "forget", memoryId: "m" },
      }).ok,
    ).toBe(true);
    // Same kind twice in one turn is refused; a different kind is fine.
    expect(
      services.requestPetHostAction({ kind: "mobileRemote", payload: { action: "close" } }).ok,
    ).toBe(false);
    // A kind the host did not declare is refused even if the tool leaked through.
    expect(
      services.requestPetHostAction({
        kind: "longTaskControl",
        payload: { taskId: "t", action: "cancel" },
      }).ok,
    ).toBe(false);

    const last = reported.at(-1);
    expect(last?.key).toBe("hostActions");
    expect(last?.value).toEqual([
      { kind: "mobileRemote", payload: { action: "open" } },
      { kind: "memory", payload: { action: "forget", memoryId: "m" } },
    ]);
  });

  test("exposes declared host-action kinds through visibility meta", () => {
    expect(
      PET_BEHAVIOR_PROFILE.buildVisibilityMeta!({ hostActions: ["memory"] }).petHostActionKinds,
    ).toEqual(["memory"]);
    expect(PET_BEHAVIOR_PROFILE.buildVisibilityMeta!({}).petHostActionKinds).toEqual([]);
  });

  test("mobile-remote tool rides the same host-action service", async () => {
    const { ctx, recorded } = context();
    expect(await mobileRemoteTool({ action: "open" }, ctx)).toContain("accepted");
    expect(recorded).toEqual([{ kind: "mobileRemote", payload: { action: "open" } }]);
  });
});
