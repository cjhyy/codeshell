/**
 * Collapse long runs of similar tool calls into a single foldable group
 * so a deep transcript doesn't bury the assistant's actual replies in
 * dozens of identical-looking "Edit foo.ts / Edit bar.ts / Bash git
 * status" rows. Codex/Cursor compresses the same way — the "current"
 * tool calls stay expanded; everything before the last assistant reply
 * gets summarised into "已编辑 N 个文件 ▶".
 *
 * Grouping rules:
 *   - Only adjacent tool messages with the same category fold together.
 *   - A group has to be at least MIN_GROUP_SIZE tools to bother folding;
 *     a single Bash stays as-is.
 *   - Tools after the LAST assistant message are considered "live" and
 *     never folded — that's the conversation the user is reading right
 *     now. Once the assistant replies, those tools become history and
 *     are eligible to fold on the next turn.
 *   - Non-tool messages (user / assistant / thinking / agent / system /
 *     context_boundary / task_list / ask_user) always pass through
 *     untouched; their kind boundary also ends any open tool group.
 */

import type { Message, ToolMessage } from "../types";

export type ToolCategory =
  | "file-edit"
  | "file-write"
  | "file-read"
  | "bash"
  | "search"
  | "web"
  | "agent"
  | "other";

export interface ToolGroup {
  kind: "tool_group";
  /** Stable id derived from the first member, so React keys stay stable. */
  id: string;
  category: ToolCategory;
  tools: ToolMessage[];
}

export type StreamItem = Message | ToolGroup;

const MIN_GROUP_SIZE = 3;

export function categorize(toolName: string): ToolCategory {
  const n = toolName.toLowerCase();
  if (n === "edit" || n === "multiedit" || n === "applypatch" || n === "apply_patch") return "file-edit";
  if (n === "write" || n === "filewrite") return "file-write";
  if (n === "read" || n === "view" || n === "fileread") return "file-read";
  if (n === "bash" || n === "shell" || n === "run") return "bash";
  if (n === "grep" || n === "glob" || n === "search") return "search";
  if (n === "webfetch" || n === "websearch" || n === "fetch") return "web";
  if (n === "agent" || n === "task" || n.startsWith("agent")) return "agent";
  return "other";
}

/** Build the display list — passthrough messages + collapsed tool groups. */
export function buildStreamItems(messages: Message[]): StreamItem[] {
  // Last assistant message index — anything after it is "live" and skips folding.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  const out: StreamItem[] = [];
  let runStart = -1;
  let runCategory: ToolCategory | null = null;

  const flushRun = (endExclusive: number): void => {
    if (runStart < 0 || runCategory === null) return;
    const tools = messages.slice(runStart, endExclusive) as ToolMessage[];
    if (tools.length >= MIN_GROUP_SIZE) {
      out.push({
        kind: "tool_group",
        id: `group-${tools[0].id}`,
        category: runCategory,
        tools,
      });
    } else {
      // Below the fold threshold — keep each tool inline so short runs
      // (1–2 calls) don't get hidden behind a "已编辑 2 个文件" stub.
      for (const t of tools) out.push(t);
    }
    runStart = -1;
    runCategory = null;
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLive = i > lastAssistantIdx; // tools after the last assistant reply
    if (m.kind === "tool" && !isLive) {
      const cat = categorize(m.toolName);
      if (runStart < 0) {
        runStart = i;
        runCategory = cat;
      } else if (cat !== runCategory) {
        flushRun(i);
        runStart = i;
        runCategory = cat;
      }
      continue;
    }
    // Any non-tool message (or a live tool we shouldn't fold) ends the run.
    flushRun(i);
    out.push(m);
  }
  flushRun(messages.length);
  return out;
}

/** Human-readable summary for the collapsed header. */
export function categoryLabel(category: ToolCategory, count: number): string {
  switch (category) {
    case "file-edit":  return `已编辑 ${count} 个文件`;
    case "file-write": return `已写入 ${count} 个文件`;
    case "file-read":  return `已读取 ${count} 个文件`;
    case "bash":       return `已运行 ${count} 条命令`;
    case "search":     return `已搜索 ${count} 次`;
    case "web":        return `已访问 ${count} 次网络`;
    case "agent":      return `已派发 ${count} 个 subagent`;
    case "other":      return `已调用 ${count} 次工具`;
  }
}
