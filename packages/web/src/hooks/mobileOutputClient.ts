import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-core";
import { recoverMobileOutput } from "../lib/mobileOutputRecovery.js";
import { compareOutputCursors } from "../lib/outputJournalRecovery.js";

type Page = Extract<MobileServerEvent, { type: "session.outputJournal" }>;
type Result = NonNullable<Awaited<ReturnType<typeof recoverMobileOutput>>>;
interface Selection {
  id: string;
  sessionId: string;
  revision: number;
  auth: number;
  recovering: boolean;
  failed: boolean;
  started?: boolean;
  latest?: string;
  applied?: string;
  pendingInputIds?: Set<string>;
  pendingInputBytes?: number;
  readyTimer?: ReturnType<typeof setTimeout>;
  waiter?: {
    id: string;
    resolve: (page: Page) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
}

/** One bounded recovery request per selected conversation, tied to this authenticated socket. */
export class MobileOutputClient {
  private enabled = false;
  private auth = 0;
  private sequence = 0;
  private selection?: Selection;
  constructor(
    private readonly deps: {
      send: (event: MobileClientEvent) => boolean;
      current: () => { sessionId?: string; roomId?: string; revision: number };
      commit: (sessionId: string, result: Result) => void;
      legacy: (sessionId: string) => void;
      failed: (sessionId: string) => void;
    },
  ) {}

  cancel(notify = true): void {
    const old = this.selection;
    this.selection = undefined;
    if (old?.readyTimer) clearTimeout(old.readyTimer);
    if (old?.waiter) {
      clearTimeout(old.waiter.timer);
      old.waiter.reject(new Error("Recovery cancelled"));
    }
    if (notify && old) this.deps.send({ type: "session.recovery.cancel" });
  }

  begin(sessionId: string): boolean {
    if (!this.enabled) return false;
    this.cancel();
    const selection: Selection = {
      id: `recovery-${this.auth}-${++this.sequence}`,
      sessionId,
      revision: this.deps.current().revision,
      auth: this.auth,
      recovering: true,
      failed: false,
    };
    this.selection = selection;
    selection.readyTimer = setTimeout(() => this.fail(selection), 10_000);
    if (!this.deps.send({ type: "session.select", sessionId, recoveryId: selection.id }))
      this.fail(selection);
    return true;
  }

  private current(selection: Selection): boolean {
    const current = this.deps.current();
    return (
      this.selection === selection &&
      selection.auth === this.auth &&
      current.sessionId === selection.sessionId &&
      !current.roomId &&
      current.revision === selection.revision
    );
  }
  owns(sessionId: string): boolean {
    return this.selection?.sessionId === sessionId;
  }
  rejectUnsequenced(sessionId: string): boolean {
    const selection = this.selection;
    if (!selection || selection.sessionId !== sessionId) return false;
    this.fail(selection);
    return true;
  }
  private fail(selection: Selection): void {
    if (!this.current(selection)) return;
    if (selection.readyTimer) clearTimeout(selection.readyTimer);
    selection.readyTimer = undefined;
    selection.recovering = false;
    selection.failed = true;
    this.deps.failed(selection.sessionId);
  }

  observe(event: MobileServerEvent): boolean {
    if (event.type === "auth.ok" || event.type === "pair.ok") {
      this.cancel(false);
      this.auth++;
      this.enabled = event.capabilities?.outputJournal === 1;
      return false;
    }
    if (event.type !== "session.recovery.ready" && event.type !== "session.outputJournal")
      return false;
    const selection = this.selection;
    if (
      !selection ||
      !this.current(selection) ||
      event.sessionId !== selection.sessionId ||
      event.recoveryId !== selection.id
    )
      return true;
    if (event.type === "session.recovery.ready") {
      if (selection.started || selection.failed) return true;
      selection.started = true;
      if (selection.readyTimer) clearTimeout(selection.readyTimer);
      selection.readyTimer = undefined;
      if (!event.ok) this.fail(selection);
      else void this.recover(selection);
    } else if (selection.waiter?.id === event.requestId) {
      const waiter = selection.waiter;
      selection.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
    return true;
  }

  private async recover(selection: Selection): Promise<void> {
    try {
      const result = await recoverMobileOutput({
        canContinue: () => this.current(selection) && !selection.failed,
        latestCursor: () => selection.latest,
        read: (options) =>
          new Promise<Page>((resolve, reject) => {
            if (!this.current(selection) || selection.waiter)
              return reject(new Error("Recovery cancelled"));
            const id = `page-${this.auth}-${++this.sequence}`;
            const timer = setTimeout(() => {
              selection.waiter = undefined;
              reject(new Error("Recovery timed out"));
            }, 10_000);
            selection.waiter = { id, resolve, reject, timer };
            if (
              !this.deps.send({
                type: "session.outputJournal",
                sessionId: selection.sessionId,
                recoveryId: selection.id,
                requestId: id,
                after: options.after,
                through: options.through,
              })
            ) {
              clearTimeout(timer);
              selection.waiter = undefined;
              reject(new Error("Recovery disconnected"));
            }
          }),
      });
      if (!this.current(selection)) return;
      if (!result) {
        this.selection = undefined;
        this.deps.send({ type: "session.recovery.cancel" });
        this.deps.legacy(selection.sessionId);
        return;
      }
      if (
        selection.pendingInputIds &&
        [...selection.pendingInputIds].some(
          (id) =>
            !result.chat.items.some((item) => item.kind === "user" && item.clientMessageId === id),
        )
      ) {
        // An input can arrive after Main captured this reply. Keep the older
        // display until its matching recorded boundary starts a fresh join.
        if (!selection.readyTimer)
          selection.readyTimer = setTimeout(() => this.fail(selection), 10_000);
        return;
      }
      selection.recovering = false;
      if (selection.readyTimer) clearTimeout(selection.readyTimer);
      selection.readyTimer = undefined;
      selection.pendingInputIds = undefined;
      selection.pendingInputBytes = undefined;
      selection.applied = result.outputCursor;
      selection.latest = result.outputCursor;
      this.deps.commit(selection.sessionId, result);
    } catch {
      this.fail(selection);
    }
  }

  /** Live output is withheld until it is covered by the frozen candidate. */
  hold(sessionId: string, raw: unknown): false | "pending" | "covered" {
    const selection = this.selection;
    if (!selection || selection.sessionId !== sessionId) return false;
    const event = raw as {
      type?: string;
      outputCursor?: string;
      clientMessageId?: unknown;
      agentId?: unknown;
      injected?: unknown;
      authority?: unknown;
    } | null;
    const priorCursor = selection.latest ?? selection.applied;
    if (typeof event?.outputCursor === "string") {
      const order = selection.latest
        ? compareOutputCursors(event.outputCursor, selection.latest)
        : 1;
      if (order === undefined) this.fail(selection);
      else if (order > 0) selection.latest = event.outputCursor;
    }
    if (selection.failed) return "pending";
    if (
      event?.type === "session_user_message" &&
      !event.outputCursor &&
      !event.agentId &&
      event.injected !== true &&
      !["agent", "system", "policy"].includes(String(event.authority))
    ) {
      const ids = (selection.pendingInputIds ??= new Set());
      if (
        typeof event.clientMessageId !== "string" ||
        !event.clientMessageId.trim() ||
        event.clientMessageId.length > 512 ||
        ids.has(event.clientMessageId)
      )
        this.fail(selection);
      else {
        ids.add(event.clientMessageId);
        selection.pendingInputBytes =
          (selection.pendingInputBytes ?? 0) +
          new TextEncoder().encode(event.clientMessageId).length;
        if (ids.size > 128 || selection.pendingInputBytes > 32 * 1024) this.fail(selection);
        if (!selection.readyTimer)
          selection.readyTimer = setTimeout(() => this.fail(selection), 10_000);
      }
      return "pending";
    }
    if (
      selection.pendingInputIds?.size &&
      event?.type === "session_started" &&
      !event.agentId &&
      event.outputCursor &&
      typeof event.clientMessageId === "string" &&
      selection.pendingInputIds.has(event.clientMessageId) &&
      (!priorCursor || compareOutputCursors(event.outputCursor, priorCursor) === 1)
    ) {
      // The real protocol emits preliminary input before the Engine owns a
      // durable Run. Retry only at its recorded boundary, never on arbitrary
      // suffix text; Main proves every pending submit ID in the candidate.
      const latest = selection.latest;
      this.begin(sessionId);
      if (this.selection) {
        this.selection.pendingInputIds = selection.pendingInputIds;
        this.selection.pendingInputBytes = selection.pendingInputBytes;
        this.selection.latest = latest;
      }
      return "pending";
    }
    if (selection.pendingInputIds?.size) return "pending";
    if (selection.failed || selection.recovering) return "pending";
    if (event?.type === "session_title") return false;
    const order =
      event?.outputCursor && selection.applied
        ? compareOutputCursors(event.outputCursor, selection.applied)
        : undefined;
    if (order === undefined) {
      this.fail(selection);
      return "pending";
    }
    return order <= 0 ? "covered" : false;
  }
  applied(sessionId: string, raw: unknown): void {
    const event = raw as { outputCursor?: string } | null;
    if (this.selection?.sessionId === sessionId && typeof event?.outputCursor === "string")
      this.selection.applied = event.outputCursor;
  }
}
