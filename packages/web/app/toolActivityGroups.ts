import type { ChatItem } from "../src/lib/streamReducer.js";

export type ActivityTool = Extract<ChatItem, { kind: "tool" }>;
export interface ToolActivityGroup {
  kind: "tool_group";
  id: string;
  items: ActivityTool[];
}

/** Unknown run/turn/source identity is never inferred from mere proximity. */
export function groupToolActivity(items: readonly ChatItem[]): Array<ChatItem | ToolActivityGroup> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const rows: Array<ChatItem | ToolActivityGroup> = [];
  let pending: ActivityTool[] = [];
  const flush = () => {
    if (pending.length > 1)
      rows.push({ kind: "tool_group", id: `tool-group:${pending[0].id}`, items: pending });
    else if (pending.length) rows.push(pending[0]);
    pending = [];
  };
  for (const item of items) {
    const tool = item.kind === "tool" ? (item as ActivityTool) : undefined;
    if (
      !tool?.done ||
      tool.error ||
      !tool.activityGroupKey ||
      !tool.id ||
      counts.get(tool.id) !== 1
    ) {
      flush();
      rows.push(item);
      continue;
    }
    if (
      pending.length &&
      (pending[0].activityGroupKey !== tool.activityGroupKey || pending[0].agentId !== tool.agentId)
    )
      flush();
    pending.push(tool);
  }
  flush();
  return rows;
}
