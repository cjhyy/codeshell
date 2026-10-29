import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-core";
import {
  recoverMobileOutput,
  MobilePendingInput,
  MobileOutputCatchupPending,
  MobileAwaitingJournal,
  type MobileLegacyBaseOptions,
} from "../lib/mobileOutputRecovery.js";
import type { OutputJournalOptions } from "@cjhyy/code-shell-core/internal";
import { compareOutputCursors } from "../lib/outputJournalRecovery.js";

type Page = Extract<MobileServerEvent, { type: "session.outputJournal" }>;
type BasePage = Extract<MobileServerEvent, { type: "session.legacyBase" }>;
type RecoveryReply = Page | BasePage;
type Result = NonNullable<Awaited<ReturnType<typeof recoverMobileOutput>>>;
interface Selection {
  id: string;
  sessionId: string;
  revision: number;
  auth: number;
  recovering: boolean;
  failed: boolean;
  started?: boolean;
  journalRequired?: boolean;
  awaitingJournal?: boolean;
  latest?: string;
  applied?: string;
  pendingInputIds?: Set<string>;
  pendingInputBytes?: number;
  readyTimer?: ReturnType<typeof setTimeout>;
  capacityTimer?: ReturnType<typeof setTimeout>;
  capacityPending?: boolean;
  capacityCursor?: string;
  retry?: { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void };
  waiter?: {
    id: string;
    type: RecoveryReply["type"];
    resolve: (page: RecoveryReply) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
}

/** One bounded recovery request per selected conversation, tied to this authenticated socket. */
export class MobileOutputClient {
  private enabled = false;
  private basePages = false;
  private auth = 0;
  private sequence = 0;
  private selection?: Selection;
  private legacyHostSelection = false;
  private lastResync?: { sessionId: string; revision: number; auth: number; at: number };
  constructor(
    private readonly deps: {
      send: (event: MobileClientEvent) => boolean;
      current: () => { sessionId?: string; roomId?: string; revision: number };
      commit: (sessionId: string, result: Result) => void;
      legacy: (sessionId: string) => void;
      failed: (sessionId: string) => void;
      awaitingJournal?: (sessionId: string) => void;
    },
  ) {}

  cancel(notify = true): void {
    const old = this.selection;
    const legacyHostSelection = this.legacyHostSelection;
    this.selection = undefined;
    this.legacyHostSelection = false;
    this.lastResync = undefined;
    if (old?.readyTimer) clearTimeout(old.readyTimer);
    if (old?.capacityTimer) clearTimeout(old.capacityTimer);
    if (old) this.clearPending(old, "Recovery cancelled");
    if (notify && (old || legacyHostSelection)) this.deps.send({ type: "session.recovery.cancel" });
  }

  private clearPending(selection: Selection, message: string): void {
    if (selection.waiter) {
      const waiter = selection.waiter;
      selection.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    if (selection.retry) {
      const retry = selection.retry;
      selection.retry = undefined;
      clearTimeout(retry.timer);
      retry.reject(new Error(message));
    }
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
    this.lastResync = { sessionId, revision: selection.revision, auth: this.auth, at: Date.now() };
    selection.readyTimer = setTimeout(() => this.fail(selection), 10_000);
    if (!this.deps.send({ type: "session.select", sessionId, recoveryId: selection.id }))
      this.fail(selection);
    return true;
  }

  /** Foreground events often arrive together; join an in-flight read instead of retiring it. */
  resync(sessionId: string): "started" | "unchanged" | false {
    if (!this.enabled) return false;
    const selection = this.selection;
    if (
      selection?.sessionId === sessionId &&
      this.current(selection) &&
      !selection.failed &&
      (selection.recovering || selection.capacityPending)
    )
      return "unchanged";
    const recent = this.lastResync;
    if (
      recent?.sessionId === sessionId &&
      recent.revision === this.deps.current().revision &&
      recent.auth === this.auth &&
      Date.now() - recent.at < 500
    )
      return "unchanged";
    return this.begin(sessionId) ? "started" : false;
  }

  pending(sessionId: string): boolean {
    const selection = this.selection;
    return Boolean(
      selection?.sessionId === sessionId &&
      this.current(selection) &&
      !selection.failed &&
      (selection.recovering || selection.capacityPending),
    );
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
    if (!this.current(selection) || selection.failed) return;
    if (selection.readyTimer) clearTimeout(selection.readyTimer);
    if (selection.capacityTimer) clearTimeout(selection.capacityTimer);
    selection.capacityTimer = undefined;
    selection.capacityPending = false;
    selection.readyTimer = undefined;
    selection.recovering = false;
    selection.failed = true;
    this.clearPending(selection, "Recovery failed");
    this.deps.failed(selection.sessionId);
  }

  observe(event: MobileServerEvent): boolean {
    if (event.type === "auth.ok" || event.type === "pair.ok") {
      this.cancel(false);
      this.auth++;
      this.enabled = event.capabilities?.outputJournal === 1;
      this.basePages = this.enabled && event.capabilities?.legacyBasePages === 1;
      return false;
    }
    if (
      event.type !== "session.recovery.ready" &&
      event.type !== "session.outputJournal" &&
      event.type !== "session.legacyBase"
    )
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
      // A later Main revocation also invalidates an already joined live stream.
      if (!event.ok) {
        this.fail(selection);
        return true;
      }
      if (selection.started || selection.failed) return true;
      selection.started = true;
      selection.journalRequired = event.journalRequired === true;
      if (selection.readyTimer) clearTimeout(selection.readyTimer);
      selection.readyTimer = undefined;
      if (!event.ok) this.fail(selection);
      else void this.recover(selection);
    } else if (selection.waiter?.id === event.requestId && selection.waiter.type === event.type) {
      const waiter = selection.waiter;
      selection.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
    return true;
  }

  private request<T extends RecoveryReply["type"]>(
    selection: Selection,
    type: T,
    options: T extends "session.outputJournal" ? OutputJournalOptions : MobileLegacyBaseOptions,
  ): Promise<Extract<RecoveryReply, { type: T }>> {
    return new Promise((resolve, reject) => {
      if (!this.current(selection) || selection.failed || selection.waiter || selection.retry)
        return reject(new Error("Recovery cancelled"));
      const id = `page-${this.auth}-${++this.sequence}`;
      const timer = setTimeout(() => {
        selection.waiter = undefined;
        reject(new Error("Recovery timed out"));
      }, 10_000);
      selection.waiter = {
        id,
        type,
        timer,
        reject,
        resolve: (page) => resolve(page as Extract<RecoveryReply, { type: T }>),
      };
      try {
        if (
          !this.deps.send({
            ...options,
            type,
            sessionId: selection.sessionId,
            recoveryId: selection.id,
            requestId: id,
          } as MobileClientEvent)
        )
          throw new Error("Recovery disconnected");
      } catch (error) {
        clearTimeout(timer);
        selection.waiter = undefined;
        reject(error);
      }
    });
  }

  private backoff(selection: Selection, delay: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.current(selection) || selection.failed)
        return reject(new Error("Recovery cancelled"));
      const timer = setTimeout(() => {
        selection.retry = undefined;
        resolve();
      }, delay);
      selection.retry = { timer, reject };
    });
  }

  private async readJournal(selection: Selection, options: OutputJournalOptions): Promise<Page> {
    for (let retries = 0; ; retries++) {
      const reply = await this.request(selection, "session.outputJournal", options);
      if (reply.busy !== true) return reply;
      if (
        Object.keys(reply).some(
          (key) => !["type", "sessionId", "recoveryId", "requestId", "page", "busy"].includes(key),
        ) ||
        reply.page.version !== 1 ||
        reply.page.status !== "incomplete" ||
        reply.page.complete !== false ||
        !Array.isArray(reply.page.frames) ||
        reply.page.frames.length !== 0 ||
        Object.keys(reply.page).some(
          (key) => !["version", "status", "frames", "complete"].includes(key),
        )
      )
        throw new Error("Invalid busy recovery reply");
      if (retries >= 8) throw new Error("Recovery reader remained busy");
      await this.backoff(selection, Math.min(50 * 2 ** retries, 1000));
    }
  }

  private async readBase(
    selection: Selection,
    options: MobileLegacyBaseOptions,
  ): Promise<BasePage> {
    for (let retries = 0; ; retries++) {
      const reply = await this.request(selection, "session.legacyBase", options);
      if (
        new TextEncoder().encode(JSON.stringify(reply)).length > 1024 * 1024 + 4096 ||
        (reply.ok === false &&
          ((reply.reason !== "busy" && reply.reason !== "incomplete") ||
            Object.keys(reply).some(
              (key) =>
                !["type", "sessionId", "recoveryId", "requestId", "ok", "reason"].includes(key),
            )))
      )
        throw new Error("Invalid recovery base reply");
      if (reply.ok !== false || reply.reason !== "busy" || retries >= 8) return reply;
      await this.backoff(selection, 25);
    }
  }

  private async recover(selection: Selection, resume?: () => Promise<Result>): Promise<void> {
    try {
      const result = await (resume
        ? resume()
        : recoverMobileOutput({
            requireJournal: selection.journalRequired,
            canContinue: () => this.current(selection) && !selection.failed,
            latestCursor: () => selection.latest,
            read: (options) => this.readJournal(selection, options),
            ...(this.basePages
              ? {
                  readBase: (options: MobileLegacyBaseOptions) => this.readBase(selection, options),
                }
              : {}),
          }));
      if (!this.current(selection)) return;
      if (!result) {
        this.selection = undefined;
        this.legacyHostSelection = true;
        // Native pre-journal history still uses the verified Host selection.
        // Cancelling it here would revoke the command/history authority before
        // the legacy request arrives. Only release local output ownership.
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
      selection.capacityPending = false;
      if (selection.readyTimer) clearTimeout(selection.readyTimer);
      selection.readyTimer = undefined;
      selection.pendingInputIds = undefined;
      selection.pendingInputBytes = undefined;
      selection.applied = result.outputCursor;
      selection.latest = result.outputCursor;
      this.deps.commit(selection.sessionId, result);
    } catch (error) {
      if (error instanceof MobileAwaitingJournal) {
        if (!this.current(selection) || selection.failed) return;
        selection.recovering = false;
        selection.awaitingJournal = true;
        // No prefix exists yet. Retain the selected producer without polling,
        // publishing an empty success, or retiring its independent command selection.
        this.deps.awaitingJournal?.(selection.sessionId);
        return;
      }
      if (error instanceof MobileOutputCatchupPending) {
        if (!this.current(selection) || selection.failed) return;
        if (
          selection.capacityCursor &&
          compareOutputCursors(error.cursor, selection.capacityCursor) !== 1
        ) {
          this.fail(selection);
          return;
        }
        selection.capacityCursor = error.cursor;
        // Keep the old display behind its barrier. One delayed follow-up also
        // consumes a terminal/head already observed during the last round; it
        // never waits forever for an event that has already arrived.
        selection.recovering = false;
        selection.capacityPending = true;
        this.deps.failed(selection.sessionId);
        selection.capacityTimer = setTimeout(() => {
          selection.capacityTimer = undefined;
          if (!this.current(selection) || selection.failed) return;
          selection.capacityPending = false;
          selection.recovering = true;
          void this.recover(selection, error.resume);
        }, 25);
        return;
      }
      if (
        error instanceof MobilePendingInput &&
        error.ids.every((id) => selection.pendingInputIds?.has(id))
      ) {
        if (!this.current(selection) || selection.failed) return;
        if (!selection.readyTimer)
          selection.readyTimer = setTimeout(() => this.fail(selection), 10_000);
        return;
      }
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
    if (selection.awaitingJournal && typeof event?.outputCursor === "string") {
      selection.awaitingJournal = false;
      if (selection.readyTimer) clearTimeout(selection.readyTimer);
      selection.readyTimer = undefined;
      selection.recovering = true;
      void this.recover(selection);
      return "pending";
    }
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
        event.clientMessageId.length > 512
      )
        this.fail(selection);
      else {
        if (!ids.has(event.clientMessageId)) {
          ids.add(event.clientMessageId);
          selection.pendingInputBytes =
            (selection.pendingInputBytes ?? 0) +
            new TextEncoder().encode(event.clientMessageId).length;
        }
        if (ids.size > 128 || (selection.pendingInputBytes ?? 0) > 32 * 1024) this.fail(selection);
        if (!selection.failed && !selection.recovering && !selection.capacityPending) {
          const latest = selection.latest;
          this.begin(sessionId);
          if (this.selection) {
            this.selection.pendingInputIds = ids;
            this.selection.pendingInputBytes = selection.pendingInputBytes;
            this.selection.latest = latest;
          }
          return "pending";
        }
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
    if (selection.failed || selection.recovering || selection.capacityPending) return "pending";
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

  /** A coalesced committed head requests pages; it never invents visible output. */
  advanceSnapshot(sessionId: string, outputCursor: string | undefined): void {
    const selection = this.selection;
    if (!selection || selection.sessionId !== sessionId || !outputCursor || selection.failed)
      return;
    const previous = selection.latest ?? selection.applied;
    const order = previous ? compareOutputCursors(outputCursor, previous) : 1;
    if (order === undefined) {
      this.fail(selection);
      return;
    }
    if (order <= 0) return;
    selection.latest = outputCursor;
    if (selection.awaitingJournal) {
      selection.awaitingJournal = false;
      if (selection.readyTimer) clearTimeout(selection.readyTimer);
      selection.readyTimer = undefined;
      selection.recovering = true;
      void this.recover(selection);
    } else if (!selection.recovering && !selection.capacityPending) {
      this.begin(sessionId);
      if (this.selection) this.selection.latest = outputCursor;
    }
  }
}
