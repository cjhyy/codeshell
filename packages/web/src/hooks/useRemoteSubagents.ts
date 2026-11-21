import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MobileClientEvent,
  MobileServerEvent,
  MobileSubagentSummary,
} from "@cjhyy/code-shell-core";
import {
  initialChatState,
  reduceScopedStream,
  type ChatItem,
  type ChatState,
} from "../lib/streamReducer.js";

/**
 * Read-only subagent views for the remote Workbench, using the data Desktop's
 * subagent panel reads: the Host's child-Session catalog and one child's
 * folded transcript. Native Sessions only; CLI rooms keep no child transcript
 * (Desktop shows their Agent/Task request card), see roomAgentItems.
 */

/** Desktop's subagent list groups, in its order. */
export type SubagentStatus = "active" | "completed" | "failed" | "paused" | "cancelled";
export const SUBAGENT_GROUPS: ReadonlyArray<{ status: SubagentStatus; label: string }> = [
  { status: "active", label: "运行中" },
  { status: "completed", label: "已完成" },
  { status: "failed", label: "失败" },
  { status: "paused", label: "已暂停" },
  { status: "cancelled", label: "已取消" },
];

export interface SubagentListItem {
  id: string;
  title: string;
  status: SubagentStatus;
  toolCount?: number;
  updatedAt?: number;
}

/** Catalog pages a view may hold (Host pages are at most 100 children). */
const MAX_CATALOG_PAGES = 5;
/** Desktop refreshes running children every 3s. */
export const SUBAGENT_POLL_MS = 3_000;
const MAX_TRAIL = 8;

type SubagentRow = Extract<ChatItem, { kind: "subagent" }>;
type ToolRow = Extract<ChatItem, { kind: "tool" }>;

function rowStatus(status: string): SubagentStatus {
  if (status === "running") return "active";
  if (status === "error") return "failed";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

/** Desktop's merge: the parent stream's rows, overlaid by the Host catalog. */
export function subagentListItems(
  rows: readonly ChatItem[],
  catalog: readonly MobileSubagentSummary[],
): SubagentListItem[] {
  const items = new Map<string, SubagentListItem>();
  for (const row of rows) {
    if (row.kind !== "subagent") continue;
    items.set(row.agentId, {
      id: row.agentId,
      title: row.label || row.agentId,
      status: rowStatus(row.status),
      ...(row.toolCount ? { toolCount: row.toolCount } : {}),
    });
  }
  for (const child of catalog) {
    const previous = items.get(child.sessionId);
    items.set(child.sessionId, {
      ...previous,
      id: child.sessionId,
      title: child.title || previous?.title || child.sessionId,
      status: child.status ?? previous?.status ?? "completed",
      ...(child.updatedAt ? { updatedAt: child.updatedAt } : {}),
    });
  }
  return [...items.values()];
}

/** CLI rooms: Desktop's per-agent view is the Agent/Task request card. */
export function roomAgentItems(items: readonly ChatItem[]): ToolRow[] {
  return items.filter(
    (item): item is ToolRow => item.kind === "tool" && /^(agent|task)$/i.test(item.name),
  );
}

export interface SubagentView {
  kind: "session";
  /** Sessions above the current list, nearest last (back pops one). */
  trail: string[];
  parentSessionId: string;
  /** Child being shown; undefined shows the list. */
  selectedId?: string;
  catalog: MobileSubagentSummary[];
  listLoading: boolean;
  listError?: string;
  transcript?: ChatState;
  transcriptLoading: boolean;
  transcriptError?: string;
}

export interface RoomAgentView {
  kind: "room";
  roomId: string;
  toolId: string;
}

export function useRemoteSubagents(send: (event: MobileClientEvent) => boolean) {
  const [view, setViewState] = useState<SubagentView | RoomAgentView>();
  const viewRef = useRef(view);
  // Replies can arrive together before a render: each must build on the last.
  const setView = useCallback((next: SubagentView | RoomAgentView | undefined) => {
    viewRef.current = next;
    setViewState(next);
  }, []);
  const requests = useRef({ seq: 0, list: "", transcript: "", pages: 0 });

  const requestList = useCallback(
    (parentSessionId: string, cursor?: string) => {
      const requestId = `sub-list-${++requests.current.seq}`;
      requests.current.list = requestId;
      if (!cursor) requests.current.pages = 0;
      return send({
        type: "session.subagents",
        requestId,
        sessionId: parentSessionId,
        ...(cursor ? { cursor } : {}),
      });
    },
    [send],
  );
  const requestTranscript = useCallback(
    (parentSessionId: string, sessionId: string) => {
      const requestId = `sub-tx-${++requests.current.seq}`;
      requests.current.transcript = requestId;
      return send({ type: "session.subagentTranscript", requestId, parentSessionId, sessionId });
    },
    [send],
  );

  const show = useCallback(
    (next: Omit<SubagentView, "kind" | "catalog" | "listLoading" | "transcriptLoading">) => {
      const listSent = requestList(next.parentSessionId);
      const transcriptSent = next.selectedId
        ? requestTranscript(next.parentSessionId, next.selectedId)
        : false;
      const offline = "连接已断开，重新连接后再读取子代理。";
      const previous = viewRef.current;
      setView({
        kind: "session",
        ...next,
        catalog:
          previous?.kind === "session" && previous.parentSessionId === next.parentSessionId
            ? previous.catalog
            : [],
        listLoading: listSent,
        ...(listSent ? {} : { listError: offline }),
        transcriptLoading: transcriptSent,
        ...(next.selectedId && !transcriptSent ? { transcriptError: offline } : {}),
      });
    },
    [requestList, requestTranscript, setView],
  );

  /** Open the list of a Session's children (optionally one child directly). */
  const open = useCallback(
    (parentSessionId: string, selectedId?: string) =>
      show({ trail: [], parentSessionId, ...(selectedId ? { selectedId } : {}) }),
    [show],
  );
  /** Select a child shown in the current view (a nested child opens its own list). */
  const select = useCallback(
    (id: string) => {
      const current = viewRef.current;
      if (current?.kind !== "session") return;
      if (current.selectedId && current.selectedId !== id) {
        if (current.trail.length >= MAX_TRAIL) return;
        // A grandchild row inside a child transcript: its parent is that child.
        show({
          trail: [...current.trail, current.parentSessionId],
          parentSessionId: current.selectedId,
          selectedId: id,
        });
        return;
      }
      show({ trail: current.trail, parentSessionId: current.parentSessionId, selectedId: id });
    },
    [show],
  );
  const openRoomAgent = useCallback(
    (roomId: string, toolId: string) => setView({ kind: "room", roomId, toolId }),
    [setView],
  );
  const close = useCallback(() => setView(undefined), [setView]);
  const back = useCallback(() => {
    const current = viewRef.current;
    if (current?.kind !== "session") return setView(undefined);
    if (current.selectedId)
      return show({ trail: current.trail, parentSessionId: current.parentSessionId });
    const parent = current.trail.at(-1);
    if (!parent) return setView(undefined);
    show({ trail: current.trail.slice(0, -1), parentSessionId: parent });
  }, [show, setView]);
  const refresh = useCallback(() => {
    const current = viewRef.current;
    if (current?.kind !== "session") return;
    requestList(current.parentSessionId);
    if (current.selectedId) requestTranscript(current.parentSessionId, current.selectedId);
  }, [requestList, requestTranscript]);

  /** Apply a Host reply; replies for an older request are ignored. */
  const observe = useCallback(
    (event: MobileServerEvent) => {
      const current = viewRef.current;
      if (current?.kind !== "session") return;
      if (event.type === "session.subagents.ok") {
        if (event.requestId !== requests.current.list) return;
        if (event.sessionId !== current.parentSessionId) return;
        const pages = ++requests.current.pages;
        const more = !event.error && event.nextCursor && pages < MAX_CATALOG_PAGES;
        const first = pages === 1;
        setView({
          ...current,
          catalog: event.error
            ? current.catalog
            : [...(first ? [] : current.catalog), ...event.agents],
          listLoading: Boolean(more),
          listError: event.error,
        });
        if (more) requestList(current.parentSessionId, event.nextCursor);
        return;
      }
      if (event.type === "session.subagentTranscript.ok") {
        if (event.requestId !== requests.current.transcript) return;
        if (event.sessionId !== current.selectedId) return;
        setView({
          ...current,
          transcriptLoading: false,
          transcriptError: event.error,
          ...(event.error
            ? {}
            : { transcript: event.events.reduce(reduceScopedStream, initialChatState()) }),
        });
      }
    },
    [requestList, setView],
  );

  const sessionView = view?.kind === "session" ? view : undefined;
  const running = sessionView
    ? sessionView.selectedId
      ? sessionView.catalog.find((child) => child.sessionId === sessionView.selectedId)?.status ===
          "active" || sessionView.transcript?.run === "running"
      : sessionView.catalog.some((child) => child.status === "active")
    : false;
  // Desktop polls running children every 3s while its panel is visible.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") refresh();
    }, SUBAGENT_POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  return { view, open, select, openRoomAgent, back, close, refresh, observe };
}

export type RemoteSubagents = ReturnType<typeof useRemoteSubagents>;

/** Rows of the parent feed shown as subagents (used to merge with the catalog). */
export function subagentRows(items: readonly ChatItem[]): SubagentRow[] {
  return items.filter((item): item is SubagentRow => item.kind === "subagent");
}
