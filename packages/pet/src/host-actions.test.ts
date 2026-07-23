import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import {
  CONTROL_LONG_TASK_TOOL_NAME,
  controlLongTaskAvailability,
  controlLongTaskTool,
  GATEWAY_REPLY_TOOL_NAME,
  gatewayReplyAvailability,
  gatewayReplyTool,
  gatewayReplyToolDef,
  isPetHostActionRequest,
  MEMORY_TOOL_NAME,
  memoryAvailability,
  memoryTool,
  rewriteGatewayReplyDef,
} from "./host-actions.js";
import { mobileRemoteAvailability, mobileRemoteTool } from "./mobile-remote.js";
import { GATEWAY_TOOL_NAME } from "./gateway.js";
import { PET_ALLOWED_TOOL_NAMES, PET_BEHAVIOR_PROFILE, PET_SYSTEM_PROMPT } from "./profile.js";

const richGatewayReply = {
  button: "native" as const,
  attachments: ["image", "file", "audio", "video"] as const,
  maxTextLength: 8_000,
  maxAttachments: 4,
  maxAttachmentBytes: 10 * 1024 * 1024,
};

function context(gatewayReply = richGatewayReply) {
  const recorded: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const kinds = new Set<string>();
  const ctx = {
    runScopedServices: {
      petGatewayReply: gatewayReply,
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

describe("GatewayReply tool", () => {
  test("records one complete text, button, and attachment reply", async () => {
    const { ctx, recorded } = context();
    expect(
      await gatewayReplyTool(
        {
          text: "结果好了",
          button: { text: "打开结果", url: "https://example.test/result" },
          attachment_paths: ["/work/app/comic.png", "/work/app/report.pdf"],
        },
        ctx,
      ),
    ).toContain("ACCEPTED EXACTLY ONCE — NOT SENT YET");
    expect(recorded).toEqual([
      {
        kind: "gatewayReply",
        payload: {
          text: "结果好了",
          button: { text: "打开结果", url: "https://example.test/result" },
          attachmentPaths: ["/work/app/comic.png", "/work/app/report.pdf"],
        },
      },
    ]);
  });

  test("rejects invalid inputs and attachments outside the declared route capability", async () => {
    const invalid = context();
    expect(await gatewayReplyTool({ text: "", attachment_paths: [] }, invalid.ctx)).toContain(
      "Error",
    );
    expect(
      await gatewayReplyTool(
        { text: "x", attachment_paths: ["/work/a.png", "/work/a.png"] },
        invalid.ctx,
      ),
    ).toContain("Error");
    expect(
      await gatewayReplyTool(
        { text: "x", button: { text: "bad", url: "javascript:alert(1)" } },
        invalid.ctx,
      ),
    ).toContain("Error");
    expect(invalid.recorded).toEqual([]);

    const textOnly = context({
      button: "link",
      attachments: [] as const,
      maxTextLength: 8_000,
      maxAttachments: 4,
      maxAttachmentBytes: 10 * 1024 * 1024,
    });
    expect(
      await gatewayReplyTool(
        { text: "x", attachment_paths: ["/work/app/comic.png"] },
        textOnly.ctx,
      ),
    ).toContain("cannot send attachments");
    expect(textOnly.recorded).toEqual([]);
  });

  test("rewrites the visible schema to the exact Gateway route", () => {
    const rich = rewriteGatewayReplyDef(gatewayReplyToolDef, {
      profileMeta: { petGatewayReply: richGatewayReply },
    } as never);
    expect(rich.inputSchema.properties).toHaveProperty("attachment_paths");
    expect(rich.description).toContain("native channel button");
    expect(rich.description).toContain("image/file/audio/video");

    const textOnly = rewriteGatewayReplyDef(gatewayReplyToolDef, {
      profileMeta: {
        petGatewayReply: {
          button: "link",
          attachments: [],
          maxTextLength: 8_000,
          maxAttachments: 4,
          maxAttachmentBytes: 10 * 1024 * 1024,
        },
      },
    } as never);
    expect(textOnly.inputSchema.properties).not.toHaveProperty("attachment_paths");
    expect(textOnly.description).toContain("does not accept outgoing attachments");
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
    expect(gatewayReplyAvailability(meta(["gatewayReply"]))).toBe(true);
    expect(gatewayReplyAvailability(meta(["memory"]))).toBe(false);
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
    expect(
      isPetHostActionRequest({
        kind: "gatewayReply",
        payload: {
          text: "给你",
          attachmentPaths: ["/work/comic.png", "/work/report.pdf"],
        },
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
        kind: "gatewayReply",
        payload: { text: "给你", attachmentPaths: ["/work/comic.png", "/work/comic.png"] },
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
  test("tells Mimi that host-mediated attachment replies are real channel sends", () => {
    expect(PET_SYSTEM_PROMPT).toContain("you MUST call GatewayReply exactly once");
    expect(PET_SYSTEM_PROMPT).toContain("two progressive tool levels");
    expect(PET_SYSTEM_PROMPT).toContain('action="search"');
    expect(PET_SYSTEM_PROMPT).toContain('action="describe"');
    expect(PET_SYSTEM_PROMPT).toContain("Never claim a listed Gateway capability is unavailable");
    expect(PET_SYSTEM_PROMPT).toContain("Do not substitute a localhost link");
  });

  test("allowlists the tools and reports one bounded request per kind per turn", () => {
    expect(PET_ALLOWED_TOOL_NAMES.has(CONTROL_LONG_TASK_TOOL_NAME)).toBe(true);
    expect(PET_ALLOWED_TOOL_NAMES.has(MEMORY_TOOL_NAME)).toBe(true);
    expect(PET_ALLOWED_TOOL_NAMES.has(GATEWAY_TOOL_NAME)).toBe(true);
    expect(PET_ALLOWED_TOOL_NAMES.has(GATEWAY_REPLY_TOOL_NAME)).toBe(true);

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
