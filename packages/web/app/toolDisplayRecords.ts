import type { ChatItem } from "../src/lib/streamReducer.js";
import type { ActivityTool, ToolActivityGroup } from "./toolActivityGroups.js";

/** A presentation container, never evidence of shared run, turn or producer identity. */
export interface ToolDisplayRecords {
  kind: "tool_records";
  id: string;
  items: ActivityTool[];
}

export function isInvisibleAssistant(item: ChatItem): boolean {
  return (
    item.kind === "assistant" &&
    item.done &&
    !item.text &&
    !item.reasoning &&
    !item.reasoningDetailRef &&
    !item.textDetailRef
  );
}

/** Compact consecutive visible records without changing their verified grouping or contents. */
export function foldToolDisplayRecords(
  items: readonly (ChatItem | ToolActivityGroup)[],
): Array<ChatItem | ToolActivityGroup | ToolDisplayRecords> {
  const counts = new Map<string, number>();
  for (const row of items) {
    for (const item of row.kind === "tool_group" ? row.items : [row])
      counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  }
  const rows: Array<ChatItem | ToolActivityGroup | ToolDisplayRecords> = [];
  let pending: Array<ActivityTool | ToolActivityGroup> = [];
  let agentId: string | undefined;
  const flush = () => {
    if (pending.length > 1) {
      const tools = pending.flatMap((row) => (row.kind === "tool_group" ? row.items : [row]));
      rows.push({ kind: "tool_records", id: `tool-records:${tools[0].id}`, items: tools });
    } else if (pending.length) rows.push(pending[0]);
    pending = [];
  };
  for (const row of items) {
    if (row.kind !== "tool_group" && isInvisibleAssistant(row)) {
      if (pending.length && row.kind === "assistant" && row.agentId === agentId) continue;
      flush();
      rows.push(row);
      continue;
    }
    const tools = row.kind === "tool_group" ? row.items : row.kind === "tool" ? [row] : [];
    if (
      !tools.length ||
      tools.some(
        (tool) =>
          !tool.done ||
          tool.error ||
          !tool.id ||
          counts.get(tool.id) !== 1 ||
          tool.agentId !== tools[0].agentId,
      )
    ) {
      flush();
      rows.push(row);
      continue;
    }
    if (pending.length && agentId !== tools[0].agentId) flush();
    agentId = tools[0].agentId;
    pending.push(row as ActivityTool | ToolActivityGroup);
  }
  flush();
  return rows;
}
