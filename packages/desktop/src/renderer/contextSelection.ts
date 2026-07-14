import type { RawTranscriptEvent } from "../preload/types";
import type { PermissionMode } from "./chat/PermissionPill";

export interface SelectableContextTurn {
  turnNumber: number;
  fromEventId: string;
  toEventId: string;
  eventIds: string[];
  preview: string;
}

const SELECTABLE_TYPES = new Set([
  "message",
  "tool_use",
  "tool_result",
  "summary",
  "context_transfer",
]);

export function isSystemReminderText(value: unknown): boolean {
  return (
    typeof value === "string" && /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(value)
  );
}

function isRealUserEvent(event: RawTranscriptEvent): boolean {
  return (
    event.type === "message" &&
    event.data.role === "user" &&
    event.data.injected !== true &&
    !isSystemReminderText(event.data.content)
  );
}

/** Build selectable complete user turns from raw core events, never renderer ids. */
export function buildSelectableContextTurns(
  events: readonly RawTranscriptEvent[],
  liveTurnActive: boolean,
): SelectableContextTurn[] {
  const turns: SelectableContextTurn[] = [];
  let current: RawTranscriptEvent[] = [];

  const finish = () => {
    if (current.length === 0) return;
    const segment = current;
    current = [];
    // A selectable task starts only at a real user message. Engine-injected
    // role:user messages (including <system-reminder>) continue the preceding
    // task instead of creating phantom user turns in the picker.
    const userEventIndex = segment.findIndex(isRealUserEvent);
    if (userEventIndex < 0) {
      const previous = turns[turns.length - 1];
      if (!previous) return;
      const continuation = segment.filter((event) => event.type !== "session_meta");
      if (continuation.length === 0) return;
      previous.eventIds.push(...continuation.map((event) => event.id));
      previous.toEventId = continuation[continuation.length - 1]!.id;
      return;
    }
    const taskTurn = segment.slice(userEventIndex);
    const selectable = taskTurn.filter((event) => SELECTABLE_TYPES.has(event.type));
    if (selectable.length === 0) {
      return;
    }
    const first = selectable[0]!;
    const last = taskTurn[taskTurn.length - 1]!;
    const previewEvent = taskTurn[0];
    const realUserEvent = previewEvent && isRealUserEvent(previewEvent) ? previewEvent : first;
    const previewContent = realUserEvent.data.content;
    turns.push({
      turnNumber: first.turnNumber,
      fromEventId: first.id,
      toEventId: last.id,
      eventIds: taskTurn.map((event) => event.id),
      preview:
        typeof previewContent === "string"
          ? previewContent.slice(0, 160)
          : `Turn ${first.turnNumber + 1}`,
    });
  };

  for (const event of events) {
    if (event.type === "session_meta" && current.length === 0) continue;
    current.push(event);
    if (event.type === "turn_boundary") finish();
  }
  if (current.length > 0 && !liveTurnActive) finish();
  return turns;
}

interface ContextSelectableDisplayItem {
  id: string;
  kind: string;
  injected?: boolean;
  text?: string;
}

export interface ContextSelectionDisplayGroup<T extends ContextSelectableDisplayItem> {
  key: string;
  selectionIndex: number | null;
  items: T[];
}

/** Group the rendered transcript into whole task turns for inline selection. */
export function groupStreamItemsIntoContextTurns<T extends ContextSelectableDisplayItem>(
  items: readonly T[],
): ContextSelectionDisplayGroup<T>[] {
  const groups: ContextSelectionDisplayGroup<T>[] = [];
  let current: T[] = [];
  let selectionIndex: number | null = null;

  const flush = () => {
    if (current.length === 0) return;
    groups.push({
      key: `${selectionIndex === null ? "preamble" : `task-${selectionIndex}`}:${current[0]!.id}`,
      selectionIndex,
      items: current,
    });
    current = [];
  };

  for (const item of items) {
    const startsTask =
      item.kind === "user" && item.injected !== true && !isSystemReminderText(item.text);
    if (startsTask) {
      flush();
      selectionIndex = selectionIndex === null ? 0 : selectionIndex + 1;
    }
    current.push(item);
  }
  flush();
  return groups;
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
