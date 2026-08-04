import { describe, expect, test } from "bun:test";
import type { ToolContext, ToolVisibilityContext } from "@cjhyy/code-shell-core/extension";
import { currentTimeTool, currentTimeAvailability } from "./current-time.js";
import { followUpsTool, manageFollowUpTool, type PetFollowUpItem } from "./follow-ups.js";
import { manageSessionsTool } from "./session-control.js";
import {
  type PetOutboundTargetOption,
  rewriteSendMessageDef,
  sendMessageAvailability,
  sendMessageTool,
  sendMessageToolDef,
} from "./outbound-message.js";

function managerContext(options: {
  followUps?: PetFollowUpItem[];
  targets?: PetOutboundTargetOption[];
}) {
  const recorded: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    runScopedServices: {
      petFollowUps: options.followUps ?? [],
      petOutboundTargets: options.targets ?? [],
      requestPetHostAction: (request: { kind: string; payload: Record<string, unknown> }) => {
        recorded.push(request);
        return { ok: true };
      },
    },
  } as unknown as ToolContext;
  return { ctx, recorded };
}

describe("Mimi atomic manager tools", () => {
  const internalSignal = new AbortController().signal;

  test("reads the same Needs follow-up rows exposed by the desktop", async () => {
    const items: PetFollowUpItem[] = [
      {
        id: "followup-a",
        title: "发布准备",
        text: "整理发布说明",
        workspace: "codeshell",
        terminalAt: 2,
        sessionSelector: "session-a",
        workspaceId: "workspace-a",
      },
      {
        id: "followup-b",
        title: "旧记录",
        text: "旧记录",
        terminalAt: 3,
        sessionSelector: "session-b",
      },
    ];
    const { ctx } = managerContext({ followUps: items });

    expect(
      JSON.parse(await followUpsTool({ action: "list", __signal: internalSignal }, ctx)).followUps,
    ).toEqual(items);
    expect(
      JSON.parse(await followUpsTool({ action: "get", follow_up_id: "followup-b" }, ctx)).followUp,
    ).toEqual(items[1]);
    expect(
      JSON.parse(await followUpsTool({ action: "search", query: "发布" }, ctx)).followUps,
    ).toEqual([items[0]]);
  });

  test("records follow-up and session mutations as separate host capabilities", async () => {
    const { ctx, recorded } = managerContext({});

    expect(
      await manageFollowUpTool(
        { action: "complete", follow_up_id: "followup-a", __signal: internalSignal },
        ctx,
      ),
    ).toContain("accepted");
    expect(
      await manageSessionsTool(
        {
          action: "archive",
          session_ids: ["session-one", "session-two"],
          __signal: internalSignal,
        },
        ctx,
      ),
    ).toContain("accepted");
    expect(recorded).toEqual([
      {
        kind: "followUpMutation",
        payload: { action: "complete", followUpId: "followup-a" },
      },
      {
        kind: "sessionArchive",
        payload: { action: "archive", sessionIds: ["session-one", "session-two"] },
      },
    ]);
    expect(
      await manageFollowUpTool({ action: "complete", follow_up_id: " followup-a" }, ctx),
    ).toContain("requires");
  });

  test("exposes proactive messaging only for exact host-authorized targets", async () => {
    const targets: PetOutboundTargetOption[] = [
      {
        id: "owner-abc",
        channel: "wechat",
        label: "微信",
        maxTextLength: 100,
        attachments: ["image", "file"],
        maxAttachments: 2,
        maxAttachmentBytes: 10 * 1024 * 1024,
      },
    ];
    const { ctx, recorded } = managerContext({ targets });
    const visibility = {
      behaviorProfile: "pet",
      profileMeta: {
        petHostActionKinds: ["outboundMessage"],
        petOutboundTargets: targets,
      },
    } as unknown as ToolVisibilityContext;

    expect(sendMessageAvailability(visibility)).toBe(true);
    const rewritten = rewriteSendMessageDef(sendMessageToolDef, visibility);
    expect(
      (
        rewritten.inputSchema.properties?.target_id as {
          enum?: string[];
        }
      ).enum,
    ).toEqual(["owner-abc"]);
    expect(rewritten.inputSchema.properties).toHaveProperty("attachment_paths");
    expect(await sendMessageTool({ target_id: "owner-unknown", text: "完成了" }, ctx)).toContain(
      "unknown target_id",
    );
    expect(await sendMessageTool({ target_id: " owner-abc", text: "完成了" }, ctx)).toContain(
      "exact authorized",
    );
    expect(
      await sendMessageTool(
        {
          target_id: "owner-abc",
          text: "完成了",
          attachment_paths: ["/work/result.png"],
          __signal: internalSignal,
        },
        ctx,
      ),
    ).toContain("REQUEST_RECORDED_NOT_DELIVERED");
    expect(
      await sendMessageTool({ target_id: "owner-abc", text: "bad\u0000message" }, ctx),
    ).toContain("message text");
    expect(recorded).toEqual([
      {
        kind: "outboundMessage",
        payload: {
          targetId: "owner-abc",
          text: "完成了",
          attachmentPaths: ["/work/result.png"],
        },
      },
    ]);
  });

  test("hides and rejects attachments for text-only proactive targets", async () => {
    const targets: PetOutboundTargetOption[] = [
      {
        id: "owner-text",
        channel: "dingtalk",
        label: "钉钉",
        maxTextLength: 100,
        attachments: [],
        maxAttachments: 0,
        maxAttachmentBytes: 0,
      },
    ];
    const { ctx, recorded } = managerContext({ targets });
    const visibility = {
      behaviorProfile: "pet",
      profileMeta: {
        petHostActionKinds: ["outboundMessage"],
        petOutboundTargets: targets,
      },
    } as unknown as ToolVisibilityContext;

    expect(
      rewriteSendMessageDef(sendMessageToolDef, visibility).inputSchema.properties,
    ).not.toHaveProperty("attachment_paths");
    expect(
      await sendMessageTool(
        { target_id: "owner-text", text: "完成了", attachment_paths: ["/work/result.png"] },
        ctx,
      ),
    ).toContain("does not support attachments");
    expect(
      await sendMessageTool({ target_id: "owner-text", text: "完成了", injected: true }, ctx),
    ).toContain("unsupported argument");
    expect(recorded).toEqual([]);
  });

  test("returns trusted current local time without host side effects", async () => {
    expect(currentTimeAvailability({ behaviorProfile: "pet" } as ToolVisibilityContext)).toBe(true);
    const result = JSON.parse(await currentTimeTool({ __signal: internalSignal })) as Record<
      string,
      unknown
    >;
    expect(typeof result.epochMs).toBe("number");
    expect(typeof result.iso).toBe("string");
    expect(typeof result.timeZone).toBe("string");
    expect(String(result.utcOffset)).toMatch(/^[+-]\d{2}:\d{2}$/u);
    expect(await currentTimeTool({ extra: true })).toContain("accepts no arguments");
  });
});
