import { describe, expect, it } from "bun:test";
import {
  buildStreamItems,
  categorize,
  categoryLabel,
} from "../packages/desktop/src/renderer/messages/streamGroups";
import type { AssistantMessage, Message, ToolMessage, UserMessage } from "../packages/desktop/src/renderer/types";

function tool(over: Partial<ToolMessage>): ToolMessage {
  return {
    kind: "tool",
    id: over.id ?? "t",
    toolName: over.toolName ?? "Bash",
    args: "{}",
    status: "succeeded",
    startedAt: 0,
    ...over,
  } as ToolMessage;
}

function assistant(id: string, text = "ok"): AssistantMessage {
  return { kind: "assistant", id, text, done: true } as AssistantMessage;
}

function user(id: string, text = "hi"): UserMessage {
  return { kind: "user", id, text } as UserMessage;
}

describe("categorize", () => {
  it("maps Edit / MultiEdit / ApplyPatch to file-edit", () => {
    expect(categorize("Edit")).toBe("file-edit");
    expect(categorize("MultiEdit")).toBe("file-edit");
    expect(categorize("apply_patch")).toBe("file-edit");
  });
  it("falls back to other for unknown tools", () => {
    expect(categorize("Skill")).toBe("other");
  });
});

describe("categoryLabel", () => {
  it("renders the count into a Chinese label", () => {
    expect(categoryLabel("file-edit", 5)).toBe("已编辑 5 个文件");
    expect(categoryLabel("bash", 3)).toBe("已运行 3 条命令");
  });
});

describe("buildStreamItems", () => {
  it("passes through messages unchanged when there are no tools", () => {
    const msgs: Message[] = [user("u1"), assistant("a1")];
    expect(buildStreamItems(msgs)).toEqual(msgs);
  });

  it("does NOT fold a short run (below MIN_GROUP_SIZE)", () => {
    const msgs: Message[] = [
      user("u1"),
      tool({ id: "t1", toolName: "Edit" }),
      tool({ id: "t2", toolName: "Edit" }),
      assistant("a1"),
    ];
    // Both Edits are before the (only) assistant — eligible to fold,
    // but only 2 of them, so they stay as plain tool messages.
    const out = buildStreamItems(msgs);
    expect(out).toHaveLength(4);
    expect(out[1].kind).toBe("tool");
    expect(out[2].kind).toBe("tool");
  });

  it("folds 3+ adjacent same-category tools into a tool_group", () => {
    const msgs: Message[] = [
      user("u1"),
      tool({ id: "t1", toolName: "Edit" }),
      tool({ id: "t2", toolName: "MultiEdit" }),
      tool({ id: "t3", toolName: "Edit" }),
      assistant("a1"),
    ];
    const out = buildStreamItems(msgs);
    // user + group + assistant
    expect(out).toHaveLength(3);
    expect(out[1].kind).toBe("tool_group");
    if (out[1].kind === "tool_group") {
      expect(out[1].category).toBe("file-edit");
      expect(out[1].tools).toHaveLength(3);
    }
  });

  it("starts a new group when the category switches", () => {
    const msgs: Message[] = [
      tool({ id: "e1", toolName: "Edit" }),
      tool({ id: "e2", toolName: "Edit" }),
      tool({ id: "e3", toolName: "Edit" }),
      tool({ id: "b1", toolName: "Bash" }),
      tool({ id: "b2", toolName: "Bash" }),
      tool({ id: "b3", toolName: "Bash" }),
      assistant("a1"),
    ];
    const out = buildStreamItems(msgs);
    expect(out).toHaveLength(3);
    expect(out[0].kind).toBe("tool_group");
    expect(out[1].kind).toBe("tool_group");
    if (out[0].kind === "tool_group" && out[1].kind === "tool_group") {
      expect(out[0].category).toBe("file-edit");
      expect(out[1].category).toBe("bash");
    }
  });

  it("never folds tools AFTER the last assistant message (live run)", () => {
    const msgs: Message[] = [
      tool({ id: "t1", toolName: "Edit" }),
      tool({ id: "t2", toolName: "Edit" }),
      tool({ id: "t3", toolName: "Edit" }),
      assistant("a1"),
      // New turn — these are "live", must stay expanded:
      tool({ id: "t4", toolName: "Edit" }),
      tool({ id: "t5", toolName: "Edit" }),
      tool({ id: "t6", toolName: "Edit" }),
    ];
    const out = buildStreamItems(msgs);
    // history group + assistant + three live tool rows
    expect(out).toHaveLength(5);
    expect(out[0].kind).toBe("tool_group");
    expect(out[1].kind).toBe("assistant");
    expect(out[2].kind).toBe("tool");
    expect(out[3].kind).toBe("tool");
    expect(out[4].kind).toBe("tool");
  });
});
