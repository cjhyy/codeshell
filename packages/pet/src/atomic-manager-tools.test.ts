import { describe, expect, test } from "bun:test";
import type { ToolContext, ToolVisibilityContext } from "@cjhyy/code-shell-core/extension";
import { currentTimeTool, currentTimeAvailability } from "./current-time.js";
import { manageSessionsTool } from "./session-control.js";
import { manageTodoTool, todosTool, type PetTodoItem } from "./todos.js";
import {
  rewriteSendMessageDef,
  sendMessageAvailability,
  sendMessageTool,
  sendMessageToolDef,
} from "./outbound-message.js";

function managerContext(options: {
  todos?: PetTodoItem[];
  targets?: Array<{ id: string; channel: string; label: string; maxTextLength: number }>;
}) {
  const recorded: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    runScopedServices: {
      petTodos: options.todos ?? [],
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
  test("reads personal todos independently from Session TodoWrite snapshots", async () => {
    const items: PetTodoItem[] = [
      {
        id: "todo-a",
        text: "整理发布说明",
        status: "pending",
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "todo-b",
        text: "旧记录",
        status: "archived",
        createdAt: 1,
        updatedAt: 3,
      },
    ];
    const { ctx } = managerContext({ todos: items });

    expect(JSON.parse(await todosTool({ action: "list" }, ctx)).todos).toEqual([items[0]]);
    expect(JSON.parse(await todosTool({ action: "get", todo_id: "todo-b" }, ctx)).todo).toEqual(
      items[1],
    );
    expect(JSON.parse(await todosTool({ action: "search", query: "发布" }, ctx)).todos).toEqual([
      items[0],
    ]);
  });

  test("records todo and session mutations as separate host capabilities", async () => {
    const { ctx, recorded } = managerContext({});

    expect(await manageTodoTool({ action: "complete", todo_id: "todo-a" }, ctx)).toContain(
      "accepted",
    );
    expect(
      await manageSessionsTool(
        { action: "archive", session_ids: ["session-one", "session-two"] },
        ctx,
      ),
    ).toContain("accepted");
    expect(recorded).toEqual([
      {
        kind: "todoMutation",
        payload: { action: "complete", todoId: "todo-a" },
      },
      {
        kind: "sessionArchive",
        payload: { action: "archive", sessionIds: ["session-one", "session-two"] },
      },
    ]);
  });

  test("exposes proactive messaging only for exact host-authorized targets", async () => {
    const targets = [{ id: "owner-abc", channel: "wechat", label: "微信", maxTextLength: 100 }];
    const { ctx, recorded } = managerContext({ targets });
    const visibility = {
      behaviorProfile: "pet",
      profileMeta: {
        petHostActionKinds: ["outboundMessage"],
        petOutboundTargets: targets,
      },
    } as unknown as ToolVisibilityContext;

    expect(sendMessageAvailability(visibility)).toBe(true);
    expect(
      (
        rewriteSendMessageDef(sendMessageToolDef, visibility).inputSchema.properties?.target_id as {
          enum?: string[];
        }
      ).enum,
    ).toEqual(["owner-abc"]);
    expect(await sendMessageTool({ target_id: "owner-unknown", text: "完成了" }, ctx)).toContain(
      "unknown target_id",
    );
    expect(await sendMessageTool({ target_id: "owner-abc", text: "完成了" }, ctx)).toContain(
      "accepted",
    );
    expect(recorded).toEqual([
      {
        kind: "outboundMessage",
        payload: { targetId: "owner-abc", text: "完成了" },
      },
    ]);
  });

  test("returns trusted current local time without host side effects", async () => {
    expect(currentTimeAvailability({ behaviorProfile: "pet" } as ToolVisibilityContext)).toBe(true);
    const result = JSON.parse(await currentTimeTool({})) as Record<string, unknown>;
    expect(typeof result.epochMs).toBe("number");
    expect(typeof result.iso).toBe("string");
    expect(typeof result.timeZone).toBe("string");
    expect(String(result.utcOffset)).toMatch(/^[+-]\d{2}:\d{2}$/u);
    expect(await currentTimeTool({ extra: true })).toContain("accepts no arguments");
  });
});
