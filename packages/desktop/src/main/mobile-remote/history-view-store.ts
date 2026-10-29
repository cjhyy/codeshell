import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readOutputJournal, readOutputJournalLegacyBase } from "@cjhyy/code-shell-core/internal";
import type {
  MobileHistoryView,
  MobileHistoryDetailResult,
  MobileOutputSnapshot,
} from "@cjhyy/code-shell-core";
import {
  applyOutputJournalPage,
  assertOutputCoverage,
  compareOutputCursors,
  initialChatState,
  reduceStream,
  transcriptToStreamEvents,
  type OutputJournalRecovery,
} from "@cjhyy/code-shell-web";
import {
  HISTORY_PAGE_ITEMS,
  HISTORY_VIEW_BUDGET,
  projectHistoryView,
  UnsupportedHistoryView,
} from "./history-view-projection.js";

const MiB = 1024 * 1024;
const PAGE_BYTES = MiB - 4096;
const DETAIL_BYTES = 256 * 1024;
const CACHE_BYTES = 64 * MiB;
export class BusyHistoryView extends Error {}
export interface HistoryViewAccess {
  binding: object;
  root: string;
  sessionId: string;
  /** Includes the current Main owner revision, even if the numeric owner returns to its old value. */
  fence: string;
  assertCurrent(): Promise<void>;
  snapshot(): MobileOutputSnapshot;
}
interface View extends ReturnType<typeof projectHistoryView> {
  id: string;
  key: Buffer;
  root: string;
  sessionId: string;
  fence: string;
  through: string;
  coverageStart: string;
  coverageIdentity?: string;
  baseThrough?: string;
  baseIdentity?: string;
  snapshot: MobileOutputSnapshot;
}
function snapshotIdentity(value: MobileOutputSnapshot) {
  if (!value.epoch || !Number.isSafeInteger(value.nextSeq) || value.nextSeq < 1 || value.unpaired)
    throw new Error("History snapshot is incomplete");
  return JSON.stringify([
    value.epoch,
    value.incarnation,
    value.journalIdentity,
    value.historicalGap,
  ]);
}
function token(view: View, kind: "before" | "detail", index: number, ref?: string) {
  const body = Buffer.from(JSON.stringify([view.id, kind, index, ref ?? null])).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", view.key).update(body).digest("base64url")}`;
}
function position(view: View, raw: string, kind: "before" | "detail", ref?: string): number {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(raw) || raw.length > 2048)
    throw new Error("Invalid history cursor");
  const [body, signature] = raw.split(".");
  const actual = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", view.key).update(body).digest();
  const bytes = Buffer.from(body, "base64url");
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected) ||
    bytes.toString("base64url") !== body ||
    actual.toString("base64url") !== signature
  )
    throw new Error("Invalid history cursor");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== view.id ||
    value[1] !== kind ||
    value[3] !== (ref ?? null) ||
    !Number.isSafeInteger(value[2]) ||
    value[2] <= 0
  )
    throw new Error("Invalid history cursor");
  return value[2];
}

/** Read-only cache of fully verified display views, never a source of write authority. */
export class MobileHistoryViewStore {
  private readonly views = new Map<object, View>();
  private bytes = 0;
  private building = false;

  revoke(binding: object): void {
    const view = this.views.get(binding);
    if (!view) return;
    this.bytes -= view.bytes;
    view.key.fill(0);
    this.views.delete(binding);
  }
  private keep(access: HistoryViewAccess, view: View) {
    this.revoke(access.binding);
    while (this.views.size >= 8 || this.bytes + view.bytes > CACHE_BYTES)
      this.revoke(this.views.keys().next().value!);
    this.views.set(access.binding, view);
    this.bytes += view.bytes;
  }
  private get(access: HistoryViewAccess): View {
    const view = this.views.get(access.binding);
    if (
      !view ||
      view.root !== access.root ||
      view.sessionId !== access.sessionId ||
      view.fence !== access.fence
    )
      throw new Error("History view is no longer available");
    this.views.delete(access.binding);
    this.views.set(access.binding, view);
    return view;
  }
  /** Recheck the complete raw chain and cutover hash on every page/detail, including cache hits. */
  private async verify(access: HistoryViewAccess, view: View, cached = true): Promise<void> {
    await access.assertCurrent();
    if (cached && this.views.get(access.binding) !== view) throw new Error("History view retired");
    this.verifySource(access, view, cached);
  }
  /** Final synchronous fence after the caller awaits this store, directly before reply. */
  confirm(access: HistoryViewAccess): void {
    this.verifySource(access, this.get(access), true);
  }
  private verifySource(access: HistoryViewAccess, view: View, cached: boolean): void {
    // No await after these raw-source checks: reply construction cannot interleave
    // with a writer or a revocation on the Main event loop.
    const page = readOutputJournal(access.root, access.sessionId, {
      after: view.through,
      through: view.through,
      maxFrames: 1,
    });
    if (
      page.status !== "ok" ||
      !page.complete ||
      page.through !== view.through ||
      page.coverageStart !== view.coverageStart ||
      page.coverageIdentity !== view.coverageIdentity ||
      page.legacyBaseThroughEventId !== view.baseThrough
    )
      throw new Error("History source changed");
    if (view.baseThrough) {
      const base = readOutputJournalLegacyBase(access.root, access.sessionId, view.baseThrough);
      if (!base.complete || JSON.stringify(base.identity) !== view.baseIdentity)
        throw new Error("History cutover changed");
    }
    const snapshot = access.snapshot();
    if (
      snapshotIdentity(snapshot) !== snapshotIdentity(view.snapshot) ||
      (cached && this.views.get(access.binding) !== view)
    )
      throw new Error("History snapshot changed");
    // The view proves a frozen prefix, not the constantly advancing live head.
    // Its actual snapshot was captured before the first journal read; later
    // inputs belong to the strictly verified live suffix, never this receipt.
    const inputs = new Set(view.verifiedInputIds);
    assertOutputCoverage(view.snapshot, page, (id) => inputs.has(id));
  }
  private page(view: View, end: number): MobileHistoryView {
    if (!Number.isSafeInteger(end) || end < 0 || end > view.items.length)
      throw new Error("Invalid history page");
    let start = Math.max(0, end - HISTORY_PAGE_ITEMS);
    const result = (): MobileHistoryView => ({
      status: "ok",
      viewId: view.id,
      through: view.through,
      coverageStart: view.coverageStart,
      ...(view.coverageIdentity ? { coverageIdentity: view.coverageIdentity } : {}),
      snapshot: view.snapshot,
      verifiedInputIds: view.verifiedInputIds,
      state: view.state,
      items: view.items.slice(start, end),
      totalItems: view.items.length,
      start,
      end,
      ...(start ? { before: token(view, "before", start) } : {}),
    });
    let page = result();
    while (Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES && start < end) {
      start++;
      page = result();
    }
    if ((end > 0 && start === end) || Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES)
      throw new UnsupportedHistoryView("History metadata exceeds one page");
    if (end === view.items.length) {
      const tail = new Set(page.items.map((item) => item.id));
      if (
        Object.values(view.state.liveByAgent).some((id) => !tail.has(id)) ||
        view.items.some((item) => item.kind === "tool" && !item.done && !tail.has(item.id))
      )
        throw new UnsupportedHistoryView("Active history cannot fit the first page");
    }
    return page;
  }
  async read(access: HistoryViewAccess, before?: string): Promise<MobileHistoryView> {
    if (before !== undefined) {
      const view = this.get(access);
      const end = position(view, before, "before");
      await this.verify(access, view);
      return this.page(view, end);
    }
    if (this.building) throw new BusyHistoryView("History projection busy");
    this.building = true;
    this.revoke(access.binding);
    try {
      const view = await this.build(access);
      const page = this.page(view, view.items.length);
      await this.verify(access, view, false);
      this.keep(access, view);
      return page;
    } finally {
      this.building = false;
    }
  }
  async detail(
    access: HistoryViewAccess,
    ref: string,
    cursor?: string,
  ): Promise<MobileHistoryDetailResult> {
    const view = this.get(access);
    const data = view.details.get(ref);
    if (!data) throw new Error("History detail is unavailable");
    const index = cursor === undefined ? 0 : position(view, cursor, "detail", ref);
    if (index >= data.length || index % DETAIL_BYTES !== 0)
      throw new Error("Invalid history detail offset");
    await this.verify(access, view);
    const end = Math.min(index + DETAIL_BYTES, data.length);
    return {
      status: "ok",
      ref,
      index,
      data: data.subarray(index, end).toString("base64"),
      totalBytes: data.length,
      ...(end === data.length
        ? { complete: true as const }
        : { complete: false as const, next: token(view, "detail", end, ref) }),
    };
  }
  private async build(access: HistoryViewAccess): Promise<View> {
    await access.assertCurrent();
    const initial = access.snapshot();
    snapshotIdentity(initial);
    let page = readOutputJournal(access.root, access.sessionId, { maxFrames: 2048 });
    if (page.status === "unavailable")
      throw new UnsupportedHistoryView("No journal projection available");
    if (page.status !== "ok" || !page.through || !page.coverageStart)
      throw new Error("History source incomplete");
    const first = page;
    const base = page.legacyBaseThroughEventId
      ? readOutputJournalLegacyBase(access.root, access.sessionId, page.legacyBaseThroughEventId)
      : undefined;
    let chat = initialChatState();
    if (base) {
      if (!base.complete || !base.identity) throw new Error("History cutover incomplete");
      const events = transcriptToStreamEvents(base.events);
      if (
        events[0]?.type !== "session_started" ||
        events.slice(1).some((event) => event.type === "session_started")
      )
        throw new Error("History cutover invalid");
      for (const event of events) chat = reduceStream(chat, event);
    }
    chat = { ...chat, run: chat.run === "error" ? "error" : "idle", liveByAgent: {} };
    const recovery: OutputJournalRecovery = { incomplete: false };
    const turns = new Map<string, string>();
    const groups = new Map<string, string>();
    let sourceBytes = 0;
    for (let pages = 0; ; pages++) {
      if (pages >= 2048) throw new UnsupportedHistoryView("History exceeds projection page budget");
      sourceBytes += Buffer.byteLength(JSON.stringify(page));
      if (sourceBytes > 128 * MiB)
        throw new UnsupportedHistoryView("History exceeds projection source budget");
      const metadata = new Map(page.frames.map((frame) => [frame.cursor, frame]));
      const complete = applyOutputJournalPage(recovery, page, (event) => {
        chat = reduceStream(chat, event);
        const frame = metadata.get(String(event.outputCursor));
        if (!frame || (!frame.runId && !frame.producer)) return;
        const identity = JSON.stringify([
          frame.runId,
          ("agentId" in event ? event.agentId : undefined) ?? null,
          frame.producer ?? null,
        ]);
        if (event.type === "stream_request_start") {
          if (Number.isSafeInteger(event.turnNumber) && event.turnNumber >= 0)
            turns.set(
              identity,
              JSON.stringify([event.turnNumber, event.messageId ?? null, event.outputCursor]),
            );
          else turns.delete(identity);
        } else if (event.type === "turn_complete") turns.delete(identity);
        else if (event.type === "tool_use_start" && turns.has(identity) && event.toolCall?.id)
          groups.set(
            event.toolCall.id,
            createHash("sha256")
              .update(JSON.stringify([identity, turns.get(identity)]))
              .digest("hex"),
          );
      });
      if (recovery.incomplete) throw new Error("History journal join incomplete");
      if (
        chat.items.length > 100_000 ||
        Buffer.byteLength(JSON.stringify(chat)) > HISTORY_VIEW_BUDGET
      )
        throw new UnsupportedHistoryView("History exceeds projection memory budget");
      await access.assertCurrent();
      if (complete) break;
      page = readOutputJournal(access.root, access.sessionId, {
        after: recovery.cursor,
        through: recovery.through,
        maxFrames: 2048,
      });
    }
    const currentSnapshot = access.snapshot();
    if (snapshotIdentity(currentSnapshot) !== snapshotIdentity(initial))
      throw new Error("History snapshot changed");
    if (initial.outputCursor !== undefined) {
      const order = compareOutputCursors(initial.outputCursor, recovery.cursor!);
      if (order === undefined) throw new Error("History cursor identity changed");
      if (order > 0) throw new Error("History initial snapshot is outside the frozen prefix");
    }
    const inputs = new Set(
      chat.items.flatMap((item) =>
        item.kind === "user" && item.clientMessageId ? [item.clientMessageId] : [],
      ),
    );
    assertOutputCoverage(initial, first, (id) => inputs.has(id));
    if (chat.sessionId !== undefined && chat.sessionId !== access.sessionId)
      throw new Error("History Session identity changed");
    // The authorized journal header supplies identity even for an empty native journal.
    const projected = projectHistoryView({ ...chat, sessionId: access.sessionId }, groups);
    return {
      ...projected,
      id: randomBytes(24).toString("base64url"),
      key: randomBytes(32),
      root: access.root,
      sessionId: access.sessionId,
      fence: access.fence,
      through: recovery.through!,
      coverageStart: recovery.coverageStart!,
      coverageIdentity: first.coverageIdentity,
      baseThrough: first.legacyBaseThroughEventId!,
      baseIdentity: base ? JSON.stringify(base.identity) : undefined,
      snapshot: initial,
    };
  }
}
