import { randomBytes } from "node:crypto";
import type {
  MobileHistoryDetail,
  MobileHistoryItem,
  MobileHistoryState,
} from "@cjhyy/code-shell-core";
import type { ChatState } from "@cjhyy/code-shell-web";

const MiB = 1024 * 1024;
export const HISTORY_VIEW_BUDGET = 32 * MiB;
export const HISTORY_PAGE_ITEMS = 80;

/** Unsupported display shapes retain the existing full, strictly verified journal path. */
export class UnsupportedHistoryView extends Error {}

function preview(text: string): string {
  let end = Math.min(text.length, 2048);
  if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + "…";
}

/** Pure display projection: opaque IDs confer no authority without the owning Host view. */
export function projectHistoryView(chat: ChatState, groups: ReadonlyMap<string, string>) {
  if (Object.keys(chat.orphanResults ?? {}).length || chat.items.length > 100_000)
    throw new UnsupportedHistoryView("History has pending display state outside its items");
  if (new Set(chat.items.map((item) => item.id)).size !== chat.items.length)
    throw new UnsupportedHistoryView("History item identities are ambiguous");
  const tail = new Set(chat.items.slice(-HISTORY_PAGE_ITEMS).map((item) => item.id));
  if (
    Object.values(chat.liveByAgent).some((id) => !tail.has(id)) ||
    chat.items.some((item) => item.kind === "tool" && !item.done && !tail.has(item.id))
  )
    throw new UnsupportedHistoryView("Active display state is outside the first page");
  const details = new Map<string, Buffer>();
  let bytes = 0;
  const save = (detail: MobileHistoryDetail) => {
    const data = Buffer.from(JSON.stringify(detail), "utf8");
    bytes += data.length;
    if (data.length > HISTORY_VIEW_BUDGET || bytes > HISTORY_VIEW_BUDGET)
      throw new UnsupportedHistoryView("History detail exceeds its memory budget");
    const ref = randomBytes(24).toString("base64url");
    details.set(ref, data);
    return ref;
  };
  const verifiedInputIds = [
    ...new Set(
      chat.items.flatMap((item) =>
        item.kind === "user" && item.clientMessageId ? [item.clientMessageId] : [],
      ),
    ),
  ];
  if (verifiedInputIds.some((id) => !id.trim() || id.length > 512))
    throw new UnsupportedHistoryView("History input identity exceeds its bound");
  const items: MobileHistoryItem[] = chat.items.map((item) => {
    if (item.kind === "tool") {
      const { args, result, ...summary } = item;
      if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args)))
        throw new UnsupportedHistoryView("History tool arguments are not a supported object");
      if (!item.done) return { ...item };
      return {
        ...summary,
        ...(args !== undefined || result !== undefined
          ? {
              detailRef: save({
                ...(args !== undefined ? { args } : {}),
                ...(result !== undefined ? { result } : {}),
              }),
            }
          : {}),
        ...(item.done && !item.error && groups.has(item.id)
          ? { activityGroupKey: groups.get(item.id)! }
          : {}),
      };
    }
    if (item.kind === "user" || item.kind === "assistant") {
      if (item.kind === "assistant" && !item.done) return { ...item };
      const longText = Buffer.byteLength(item.text) > 4096;
      const longReasoning = item.kind === "assistant" && Buffer.byteLength(item.reasoning) > 4096;
      const ref =
        longText || longReasoning
          ? save({
              ...(longText ? { text: item.text } : {}),
              ...(longReasoning ? { reasoning: item.reasoning } : {}),
            })
          : undefined;
      return {
        ...item,
        ...(longText ? { text: preview(item.text), textDetailRef: ref } : {}),
        ...(longReasoning ? { reasoning: preview(item.reasoning), reasoningDetailRef: ref } : {}),
      };
    }
    return { ...item };
  });
  const { items: _items, orphanResults: _orphans, ...state } = chat;
  const sizes = items.map((item) => Buffer.byteLength(JSON.stringify(item)));
  bytes += sizes.reduce((total, size) => total + size, 0);
  bytes += Buffer.byteLength(JSON.stringify({ state, verifiedInputIds }));
  if (bytes > HISTORY_VIEW_BUDGET)
    throw new UnsupportedHistoryView("History view exceeds its memory budget");
  return { items, sizes, details, state: state as MobileHistoryState, verifiedInputIds, bytes };
}
