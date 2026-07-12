import type { RawTranscriptEvent } from "../preload/types";
import type { PermissionMode } from "./chat/PermissionPill";

export interface SelectableContextTurn {
  turnNumber: number;
  fromEventId: string;
  toEventId: string;
  eventIds: string[];
  preview: string;
}

const SELECTABLE_TYPES = new Set(["message", "tool_use", "tool_result", "summary"]);

/** Build selectable complete turns from raw core events, never renderer ids. */
export function buildSelectableContextTurns(
  events: readonly RawTranscriptEvent[],
  liveTurnActive: boolean,
): SelectableContextTurn[] {
  const turns: SelectableContextTurn[] = [];
  let current: RawTranscriptEvent[] = [];

  const finish = () => {
    if (current.length === 0) return;
    const selectable = current.filter((event) => SELECTABLE_TYPES.has(event.type));
    if (selectable.length === 0) {
      current = [];
      return;
    }
    const first = selectable[0]!;
    const last = current[current.length - 1]!;
    const previewEvent = selectable.find(
      (event) => event.type === "message" && event.data.role === "user",
    );
    const previewContent = previewEvent?.data.content;
    turns.push({
      turnNumber: first.turnNumber,
      fromEventId: first.id,
      toEventId: last.id,
      eventIds: current.map((event) => event.id),
      preview:
        typeof previewContent === "string"
          ? previewContent.slice(0, 160)
          : `Turn ${first.turnNumber + 1}`,
    });
    current = [];
  };

  for (const event of events) {
    if (event.type === "session_meta" && current.length === 0) continue;
    current.push(event);
    if (event.type === "turn_boundary") finish();
  }
  if (current.length > 0 && !liveTurnActive) finish();
  return turns;
}

export function selectedTurnRange(
  turns: readonly SelectableContextTurn[],
  fromIndex: number,
  toIndex: number,
): { fromEventId: string; toEventId: string } {
  if (fromIndex > toIndex) throw new Error("Selected turn range is out of order");
  const from = turns[fromIndex];
  const to = turns[toIndex];
  if (!from || !to) throw new Error("Selected turn range is outside the available turns");
  return { fromEventId: from.fromEventId, toEventId: to.toEventId };
}

export function copyContextPackageOverrides(options: {
  sourceBucket: string;
  targetBucket: string;
  modelOverrides: Record<string, string>;
  permissionOverrides: Record<string, PermissionMode>;
  goalOverrides: Record<string, boolean>;
  defaultModel: string | null;
  defaultPermission: PermissionMode | null;
}): {
  modelOverrides: Record<string, string>;
  permissionOverrides: Record<string, PermissionMode>;
  goalOverrides: Record<string, boolean>;
} {
  const sourceModel = options.modelOverrides[options.sourceBucket] ?? options.defaultModel;
  const sourcePermission =
    options.permissionOverrides[options.sourceBucket] ?? options.defaultPermission;
  return {
    modelOverrides: sourceModel
      ? { ...options.modelOverrides, [options.targetBucket]: sourceModel }
      : options.modelOverrides,
    permissionOverrides: sourcePermission
      ? { ...options.permissionOverrides, [options.targetBucket]: sourcePermission }
      : options.permissionOverrides,
    goalOverrides: { ...options.goalOverrides, [options.targetBucket]: false },
  };
}
