import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  SessionManager,
  UsageLedger,
  sessionsRoot,
  type TerminalReason,
} from "@cjhyy/code-shell-core";
import {
  createSessionOperationServices,
  readOperationSessionOwner,
} from "@cjhyy/code-shell-core/internal";
import type { CreateSessionToolHostOptions } from "@cjhyy/code-shell-core/extension";

type RunContext = NonNullable<
  ReturnType<NonNullable<CreateSessionToolHostOptions["captureRunContext"]>>
>;
type SourceContext = Pick<RunContext, "workspaceProfileName" | "isSourceProfileCurrent">;
type OperationRunInput = {
  sessionId: string;
  runId: string;
  originClientMessageId: string;
  isCurrent(): boolean;
  sourceContext?: SourceContext;
  root?: string;
};

export const EXTERNAL_UNVERIFIED_WRITE_NOTICE =
  "外部写操作尚未通过独立回读验证，任务未标记完成。请先确认已发送操作的实际结果，避免重复写入。";

/** One Host-owned submission lease; model arguments cannot create or replace it. */
export class ExternalRuntimeOperationRun {
  readonly context: RunContext;
  private readonly abort = new AbortController();
  private readonly usage: UsageLedger;
  private readonly controller;
  private readonly incarnation: string;
  private readonly directory: { dev: number; ino: number };
  private readonly workspace: string;
  private closed = false;
  private sealed: boolean | undefined;
  private readonly root: string;
  private readonly input: Readonly<OperationRunInput>;

  constructor(input: OperationRunInput) {
    this.input = input = Object.freeze({ ...input });
    this.root = input.root ?? sessionsRoot();
    const sessions = new SessionManager(this.root);
    this.usage = new UsageLedger({ storageDir: join(this.root, ".usage-ledger") });
    sessions.updateSessionRunState(input.sessionId, input.runId, (state) => {
      if (state.status !== "active" || !input.isCurrent()) throw new Error("External run changed");
      const adopted = this.usage.adoptSession(input.sessionId, state.costState, this.root);
      if (!adopted && state.costState?.kind === "usage-ledger")
        throw new Error("External accounting owner changed");
      // The external provider owns its model loop and supplies no model billing
      // receipts. Keep known Host costs without presenting their subtotal as an
      // exact total, even on the first turn with zero persisted tokens.
      this.usage.noteHistoricalGap(input.sessionId, this.root);
      return { costState: this.usage.sessionState(input.sessionId, this.root) };
    });
    const owner = readOperationSessionOwner(this.root, input.sessionId, this.usage);
    this.incarnation = owner.incarnation;
    const directory = lstatSync(owner.directory);
    this.directory = { dev: directory.dev, ino: directory.ino };
    this.workspace = JSON.stringify([owner.state.cwd, owner.state.project, owner.state.workspace]);
    const operations = createSessionOperationServices(
      this.root,
      input.sessionId,
      input.runId,
      this.usage,
      () => this.assertCurrent(),
    );
    this.controller = operations.controller;
    this.context = Object.freeze({
      ...input.sourceContext,
      operations: input.originClientMessageId
        ? {
            ...operations,
            // External submissions currently own one operation slot per trusted
            // intent. This callback only checks custody; it never mints a batch.
            batchAuthority: async () => {
              this.assertCurrent();
              return { kind: "single" as const };
            },
            onToolFailure: async () => {
              if (!this.ownsRun()) return;
              if (this.controller.ledger.hasUnverifiedWrites(input.sessionId))
                this.abort.abort("An external write requires independent verification");
            },
          }
        : undefined,
      originClientMessageId: input.originClientMessageId,
      signal: this.abort.signal,
      assertCurrent: () => this.assertCurrent(),
    });
  }

  private ownsRun(): boolean {
    if (!this.input.isCurrent()) return false;
    try {
      const owner = readOperationSessionOwner(this.root, this.input.sessionId, this.usage);
      const directory = lstatSync(owner.directory);
      return (
        owner.incarnation === this.incarnation &&
        directory.dev === this.directory.dev &&
        directory.ino === this.directory.ino &&
        owner.state.runId === this.input.runId &&
        owner.state.status === "active" &&
        JSON.stringify([owner.state.cwd, owner.state.project, owner.state.workspace]) ===
          this.workspace
      );
    } catch {
      return false;
    }
  }

  assertCurrent(): void {
    if (this.closed || this.abort.signal.aborted || !this.ownsRun())
      throw new Error("External tool submission is no longer current");
  }

  capture(): RunContext | undefined {
    try {
      this.assertCurrent();
      return this.context;
    } catch {
      return undefined;
    }
  }

  hasUnverifiedWrites(): boolean {
    return (
      this.sealed ??
      (this.ownsRun() && this.controller.ledger.hasUnverifiedWrites(this.input.sessionId) === true)
    );
  }

  /** Close intake before terminal publication or cancellation, and freeze pending sends. */
  finish(): boolean {
    if (this.sealed !== undefined) return this.sealed;
    const owned = this.ownsRun();
    this.closed = true;
    this.abort.abort("External submission ended");
    // A superseded lease cannot seal the newer run's receipts. Its own pending
    // receipt still prevents the next controller from sending another write.
    this.sealed =
      owned && this.controller.ledger.sealForFinalization(this.input.sessionId) === true;
    return this.sealed;
  }

  terminalReason(reason: TerminalReason): TerminalReason {
    return this.finish() && reason === "completed" ? "unverified_write" : reason;
  }
}
