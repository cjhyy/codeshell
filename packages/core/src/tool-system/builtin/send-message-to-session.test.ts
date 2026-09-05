import { describe, expect, test } from "bun:test";
import type { SessionMessageReceipt, SessionMessageTarget } from "../../session/session-message.js";
import type { ToolContext, ToolVisibilityContext } from "../context.js";
import { BUILTIN_TOOLS } from "./index.js";
import {
  rewriteSendMessageToSessionToolDefinition,
  sendMessageToSessionTool,
  sendMessageToSessionToolDef,
} from "./send-message-to-session.js";

const targets: SessionMessageTarget[] = [
  {
    sessionId: "ui-session",
    title: "Design UI",
    workspaceRoot: "/project",
    workspaceProfile: "designer",
  },
  {
    sessionId: "review-session",
    title: "Review",
    workspaceRoot: "/project",
  },
];

describe("SendMessageToSession", () => {
  test("rewrites the target id into the host-authorized closed enum", () => {
    const rewritten = rewriteSendMessageToSessionToolDefinition(sendMessageToSessionToolDef, {
      cwd: "/project",
      hasGoal: false,
      sessionMessageTargets: targets,
    });
    const properties = rewritten.inputSchema.properties as Record<string, { enum?: string[] }>;

    expect(properties.target_session_id?.enum).toEqual(["ui-session", "review-session"]);
    expect(rewritten.description).toContain("Design UI");
    expect(rewritten.description).toContain("designer");
  });

  test("forwards one ordinary message to the selected Session without changing it", async () => {
    let sent: { targetSessionId: string; message: string } | undefined;
    const message = "  Please design the PRD in docs/prd.md.  ";
    const ctx = {
      sessionMessages: {
        targets,
        send: async (input: { targetSessionId: string; message: string }) => {
          sent = input;
          return targets[0]!;
        },
      },
    } as unknown as ToolContext;

    const output = await sendMessageToSessionTool(
      { target_session_id: "ui-session", message },
      ctx,
    );

    expect(sent).toEqual({ targetSessionId: "ui-session", message });
    expect(output).toContain('Message accepted by "Design UI" (ui-session)');
    expect(output).toContain("did not provide execution status or automatic reply delivery");
    expect(output).not.toContain("queued");
    expect(output).not.toContain("started");
    expect(output).not.toContain("completed");
  });

  test.each([
    { status: "queued", expected: "status: queued (not yet confirmed started)" },
    { status: "started", expected: "status: started" },
  ] as const)("reports $status without claiming completion", async ({ status, expected }) => {
    const output = await sendMessageToSessionTool(
      { target_session_id: "ui-session", message: "Read the existing results." },
      {
        sessionMessages: {
          targets,
          send: async () => ({
            ...targets[0]!,
            receipt: { messageId: "message-42", status },
          }),
        },
      } as unknown as ToolContext,
    );

    expect(output).toContain('Message message-42 accepted by "Design UI" (ui-session)');
    expect(output).toContain(expected);
    expect(output).toContain("answer or failure will be returned to this Session automatically");
    expect(output).not.toContain("completed");
  });

  test("returns an already completed target answer with its message id", async () => {
    const receipt: SessionMessageReceipt = {
      messageId: "message-43",
      status: "completed",
      result: {
        text: "Read successfully. Existing result: https://github.com/example/repo",
        reason: "completed",
      },
    };
    const output = await sendMessageToSessionTool(
      { target_session_id: "ui-session", message: "Read the existing results." },
      {
        sessionMessages: {
          targets,
          send: async () => ({ ...targets[0]!, receipt }),
        },
      } as unknown as ToolContext,
    );

    expect(output).toContain('Message message-43 completed in "Design UI" (ui-session)');
    expect(output).toContain(receipt.result!.text);
    expect(output).not.toContain("queued");
    expect(output).not.toContain("will be returned");
  });

  test("reports a rejected dispatch as an error instead of queued work", async () => {
    const output = await sendMessageToSessionTool(
      { target_session_id: "ui-session", message: "Read the existing results." },
      {
        sessionMessages: {
          targets,
          send: async () => {
            throw new Error("WorkspaceContext is required for this project Session.");
          },
        },
      } as unknown as ToolContext,
    );

    expect(output).toBe("Error: WorkspaceContext is required for this project Session.");
  });

  test("rejects empty messages and unavailable services", async () => {
    expect(
      await sendMessageToSessionTool({ target_session_id: "ui-session", message: "   " }, {
        sessionMessages: { targets, send: async () => targets[0]! },
      } as unknown as ToolContext),
    ).toContain("message is required");
    expect(
      await sendMessageToSessionTool(
        { target_session_id: "ui-session", message: "work" },
        undefined,
      ),
    ).toContain("not available");
  });

  test("is registered as an allowed mutating tool and hidden without targets", () => {
    const entry = BUILTIN_TOOLS.find(
      (candidate) => candidate.definition.name === "SendMessageToSession",
    );
    expect(entry).toBeDefined();
    expect(entry!.definition.permissionDefault).toBe("allow");
    expect(entry!.definition.isReadOnly).toBe(false);
    const available = entry!.exposure.availability!;
    const context = (overrides: Partial<ToolVisibilityContext>): ToolVisibilityContext => ({
      cwd: "/project",
      hasGoal: false,
      ...overrides,
    });
    expect(available(context({ sessionMessageTargets: targets }))).toBe(true);
    expect(available(context({ sessionMessageTargets: [] }))).toBe(false);
    expect(available(context({ sessionMessageTargets: targets, isSubAgent: true }))).toBe(false);
    expect(
      available(
        context({ sessionMessageTargets: targets, behaviorProfile: "quickChatRestricted" }),
      ),
    ).toBe(false);
  });
});
