import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-core";

/**
 * Earlier-history paging for an external CLI room (Claude Code / Codex).
 *
 * The Host parses the CLI transcript into an index-stable message list (the
 * transcript only grows). The opening snapshot shows its newest messages, so
 * the first shown index is `totalCount - messages.length`; each earlier page
 * asks for messages before that index and moves it back. Pages are strictly
 * older than everything shown, so they never overlap the snapshot or the live
 * room feed. Pages and the total prepended count are bounded.
 */

export const ROOM_HISTORY_PAGE_SIZE = 100;
/** Earlier messages one conversation view may hold beyond its snapshot. */
export const MAX_ROOM_HISTORY_PREPENDED = 2_000;
const PAGE_TIMEOUT_MS = 30_000;

type ReadHistory = Extract<MobileClientEvent, { type: "ccRoom.readHistory" }>;
type ReadHistoryOk = Extract<MobileServerEvent, { type: "ccRoom.readHistory.ok" }>;

export interface RoomHistoryWindow {
  roomId: string;
  sessionId: string;
  cwd: string;
  kind: "claude-code" | "codex";
  /** Transcript index of the earliest message shown. */
  startIndex: number;
  /** Earlier messages prepended so far. */
  prepended: number;
  loading: boolean;
  error?: string;
}

export function roomHistoryHasEarlier(
  window: RoomHistoryWindow | undefined,
  roomId: string | undefined,
): boolean {
  return (
    !!window &&
    window.roomId === roomId &&
    window.startIndex > 0 &&
    window.prepended < MAX_ROOM_HISTORY_PREPENDED
  );
}

export class RoomHistoryPager {
  private current?: RoomHistoryWindow;
  private pending?: {
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(private readonly publish: (window: RoomHistoryWindow | undefined) => void) {}

  get window(): RoomHistoryWindow | undefined {
    return this.current;
  }

  /** A transcript snapshot (or legacy backlog) is now the bottom of the view. */
  start(
    room: Pick<RoomHistoryWindow, "roomId" | "sessionId" | "cwd" | "kind">,
    snapshot: { messages: readonly unknown[]; totalCount: number; startIndex?: number },
  ): void {
    this.settle(new Error("superseded"));
    this.set({
      ...room,
      startIndex:
        snapshot.startIndex ?? Math.max(0, snapshot.totalCount - snapshot.messages.length),
      prepended: 0,
      loading: false,
    });
  }

  /** Request the page before the earliest shown message. */
  load(roomId: string | undefined, send: (event: ReadHistory) => boolean): Promise<void> {
    const window = this.current;
    if (!window || !roomHistoryHasEarlier(window, roomId) || window.loading)
      return Promise.reject(new Error("没有更早的 CLI 记录可读取。"));
    const limit = Math.min(
      ROOM_HISTORY_PAGE_SIZE,
      MAX_ROOM_HISTORY_PREPENDED - window.prepended,
      window.startIndex,
    );
    const sent = send({
      type: "ccRoom.readHistory",
      cwd: window.cwd,
      sessionId: window.sessionId,
      kind: window.kind,
      limit,
      before: window.startIndex,
    });
    if (!sent) return Promise.reject(this.fail("连接已断开，重新连接后再读取更早记录。"));
    this.set({ ...window, loading: true, error: undefined });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle(this.fail("读取更早的 CLI 记录超时，请重试。")),
        PAGE_TIMEOUT_MS,
      );
      this.pending = { resolve, reject, timer };
    });
  }

  /**
   * Apply a paged reply. Returns false when the reply is not this view's
   * current request (another room, session, or an already moved boundary).
   */
  accept(
    reply: ReadHistoryOk,
    roomId: string | undefined,
    prepend: (messages: ReadHistoryOk["messages"], key: string) => void,
  ): boolean {
    const window = this.current;
    if (
      !window ||
      !window.loading ||
      window.roomId !== roomId ||
      reply.sessionId !== window.sessionId ||
      reply.before !== window.startIndex
    )
      return false;
    if (
      typeof reply.startIndex !== "number" ||
      reply.startIndex > window.startIndex ||
      reply.messages.length > window.startIndex - reply.startIndex
    ) {
      this.settle(this.fail("此电脑不支持分页读取 CLI 记录，请更新桌面端。"));
      return true;
    }
    if (reply.messages.length) prepend(reply.messages, `${window.sessionId}-${reply.startIndex}`);
    this.set({
      ...window,
      startIndex: reply.startIndex,
      prepended: window.prepended + reply.messages.length,
      loading: false,
    });
    this.settle();
    return true;
  }

  private fail(message: string): Error {
    if (this.current) this.set({ ...this.current, loading: false, error: message });
    return new Error(message);
  }

  private settle(error?: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private set(window: RoomHistoryWindow | undefined): void {
    this.current = window;
    this.publish(window);
  }
}
