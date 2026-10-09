import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from "electron";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type { CredentialMetadata } from "@cjhyy/code-shell-core";
import {
  createGithubIssueBatch,
  normalizeGithubIssueBatch,
  readOperationSessionOwner,
  githubIssueBatchPolicy,
  allowsLinkAction,
  linkAuthoritySnapshot,
  type DesktopOperationBatchAuthorityInput,
  type DesktopOperationBatchAuthorityResult,
} from "@cjhyy/code-shell-core/internal";
import type { ResolvedRendererConfigurationTarget } from "./renderer-configuration-authority.js";
import type { OperationBatchResult } from "../shared/operation-batch.js";

interface BatchBridge {
  workerGeneration(): number;
  claimSessionPanelOwner(sessionId: string, webContentsId: number): void;
  panelOwnerWebContentsId(sessionId: string): number | undefined;
  sessionPanelOwnerRevision(sessionId: string): number;
  hasLiveWorker(): boolean;
  setOperationBatchResolver(
    resolver:
      | ((
          input: DesktopOperationBatchAuthorityInput,
          generation: number,
        ) => Promise<DesktopOperationBatchAuthorityResult>)
      | undefined,
  ): void;
  requestOperationBatchRun(
    params: Record<string, unknown>,
    token: string,
    assertCurrent: () => void,
  ): Promise<unknown>;
}
interface Deps {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  windows(): BrowserWindow[];
  enabled(): boolean;
  root: string;
  bridge(): BatchBridge | undefined;
  resolveTarget(input: unknown): Promise<ResolvedRendererConfigurationTarget>;
  trusted(cwd: string): Promise<boolean>;
  trustedSync(cwd: string): boolean;
  authorityRevision(): string;
  isSessionRunning(sessionId: string): boolean;
  connections(cwd: string): CredentialMetadata[];
  confirm(window: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>;
}
function exact(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid Issue batch proposal");
  return input as Record<string, unknown>;
}
function identity(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Batch project unavailable");
  return JSON.stringify([path, stat.dev, stat.ino]);
}
function fixedOwner(owner: ReturnType<typeof readOperationSessionOwner>) {
  return JSON.stringify([
    owner.incarnation,
    identity(owner.directory),
    owner.state.cwd,
    owner.state.project,
    owner.state.workspace,
    owner.state.workspaceProfile,
  ]);
}
function eligible(connection: CredentialMetadata): boolean {
  return (
    connection.meta?.linkProvider === "github" &&
    connection.hasSecret &&
    connection.meta?.linkExecutionBackend !== "cli" &&
    (!connection.oauthStatus || ["valid", "expired"].includes(connection.oauthStatus.state)) &&
    ["create_issue", "list_issues", "get_issue"].every((action) =>
      allowsLinkAction(connection, "github", action),
    )
  );
}

/** Native activity entry. A renderer can propose data, but cannot approve/mint a batch. */
export function registerOperationBatchIpc(deps: Deps): () => Promise<void> {
  type Permit = {
    token: string;
    sessionId: string;
    origin: string;
    runId?: string;
    generation?: number;
    connectionId: string;
    batch: ReturnType<typeof createGithubIssueBatch>;
    check(): void;
    closed: boolean;
  };
  const permits = new Map<string, Permit>();
  const sessions = new Set<string>();
  let disposed = false;
  const owner = (event: IpcMainInvokeEvent) => {
    const window = deps
      .windows()
      .find((candidate) => !candidate.isDestroyed() && candidate.webContents === event.sender);
    if (disposed || !deps.enabled() || !window || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Issue batch requires the application top frame");
    return window;
  };
  const context = async (sessionId: unknown, check: () => void) => {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128)
      throw new Error("Invalid batch Session");
    const revision = deps.authorityRevision();
    const target = await deps.resolveTarget({ sessionId });
    check();
    if (
      target.kind !== "session" ||
      target.sessionId !== sessionId ||
      !target.projectId ||
      !(await deps.trusted(target.cwd))
    )
      throw new Error("Batch requires a trusted project Session");
    check();
    if (
      revision !== deps.authorityRevision() ||
      deps.isSessionRunning(sessionId) ||
      sessions.has(sessionId)
    )
      throw new Error("Stop the Session before approving a new Issue batch");
    const sessionOwner = readOperationSessionOwner(deps.root, sessionId);
    if (sessionOwner.state.status === "active") throw new Error("Batch Session is running");
    return { target, revision, owner: fixedOwner(sessionOwner), root: identity(target.cwd) };
  };
  const close = (permit: Permit) => {
    permit.closed = true;
    // Keep the permit map entry while sealing fails: never downgrade to ordinary single.
    permit.batch.close();
    permits.delete(permit.token);
    sessions.delete(permit.sessionId);
  };
  const resolve = async (
    input: DesktopOperationBatchAuthorityInput,
    generation: number,
  ): Promise<DesktopOperationBatchAuthorityResult> => {
    // The closed-set client validates data before send; Main also treats worker frames as data.
    const permit = typeof input.token === "string" ? permits.get(input.token) : undefined;
    if (!permit) {
      if (
        input.token ||
        [...permits.values()].some(
          (entry) => entry.sessionId === input.sessionId && entry.origin === input.originIntent,
        )
      )
        throw new Error("Batch admission is absent or ended");
      return { kind: "single" };
    }
    try {
      if (
        permit.closed ||
        input.sessionId !== permit.sessionId ||
        input.originIntent !== permit.origin
      )
        throw new Error("Batch Run identity changed");
      permit.check();
      const current = readOperationSessionOwner(deps.root, permit.sessionId);
      if (current.state.runId !== input.runId || current.state.status !== "active")
        throw new Error("Batch must belong to the actual active Run");
      if (
        (permit.runId && permit.runId !== input.runId) ||
        (permit.generation !== undefined && permit.generation !== generation)
      )
        throw new Error("Batch cannot move to another Run or worker");
      permit.runId = input.runId;
      permit.generation = generation;
      if (input.phase === "cancel") {
        close(permit);
        return {
          kind: "batch",
          batchId: permit.batch.id,
          index: 0,
          count: permit.batch.count,
          allVerified: false,
        };
      }
      if (input.phase === "finish") return permit.batch.finish();
      if (!["resolve", "check"].includes(input.phase) || input.connectionId !== permit.connectionId)
        throw new Error("Batch connection changed");
      return permit.batch.resolve(input.parameters);
    } catch (error) {
      try {
        close(permit);
      } catch {
        permit.closed = true;
      }
      throw error;
    }
  };
  const bridges = new Set<BatchBridge>();
  deps.ipc.handle("operationBatch:options", async (event, input) => {
    const window = owner(event),
      frame = event.senderFrame;
    const check = () => {
      if (owner(event) !== window || frame !== event.sender.mainFrame)
        throw new Error("Batch frame changed");
    };
    const { sessionId } = exact(input, ["sessionId"]);
    const current = await context(sessionId, check);
    return {
      connections: deps
        .connections(current.target.cwd)
        .filter(eligible)
        .map(({ id, label }) => ({ id, label })),
    };
  });
  deps.ipc.handle("operationBatch:start", async (event, input): Promise<OperationBatchResult> => {
    const window = owner(event),
      frame = event.senderFrame;
    const check = () => {
      if (owner(event) !== window || frame !== event.sender.mainFrame)
        throw new Error("Batch frame changed");
    };
    const proposal = exact(input, ["sessionId", "connectionId", "items"]);
    const current = await context(proposal.sessionId, check);
    const sessionId = proposal.sessionId as string;
    if (sessions.has(sessionId))
      throw new Error("A batch confirmation is already pending for this Session");
    sessions.add(sessionId);
    let permit: Permit | undefined;
    try {
      const bridge = deps.bridge();
      if (!bridge) throw new Error("Batch worker bridge unavailable");
      bridge.setOperationBatchResolver(resolve);
      bridges.add(bridge);
      const items = normalizeGithubIssueBatch(proposal.items);
      const connection = deps
        .connections(current.target.cwd)
        .find((entry) => entry.id === proposal.connectionId && eligible(entry));
      if (!connection)
        throw new Error("Choose a current GitHub connection with write and verification scopes");
      const authority = linkAuthoritySnapshot(connection);
      const sessionProfile = readOperationSessionOwner(deps.root, sessionId).state.workspaceProfile;
      const policy = githubIssueBatchPolicy(
        current.target.cwd,
        typeof sessionProfile === "string" ? sessionProfile : undefined,
      );
      const previousOwner = bridge.panelOwnerWebContentsId(sessionId);
      if (previousOwner !== undefined && previousOwner !== window.webContents.id)
        throw new Error("Batch Session belongs to another window");
      // Claim before the Native await so none→other→forget cannot restore a zero revision.
      bridge.claimSessionPanelOwner(sessionId, window.webContents.id);
      const ownerRevision = bridge.sessionPanelOwnerRevision(sessionId);
      const assertCurrent = () => {
        check();
        const liveOwner = bridge.panelOwnerWebContentsId(sessionId);
        if (
          bridge.sessionPanelOwnerRevision(sessionId) !== ownerRevision ||
          (liveOwner !== undefined && liveOwner !== window.webContents.id) ||
          deps.authorityRevision() !== current.revision ||
          !deps.trustedSync(current.target.cwd) ||
          identity(current.target.cwd) !== current.root ||
          fixedOwner(readOperationSessionOwner(deps.root, sessionId)) !== current.owner ||
          githubIssueBatchPolicy(
            current.target.cwd,
            typeof sessionProfile === "string" ? sessionProfile : undefined,
          ) !== policy ||
          !deps
            .connections(current.target.cwd)
            .some((entry) => eligible(entry) && linkAuthoritySnapshot(entry) === authority)
        )
          throw new Error("Batch project, owner, Profile or account authority changed");
      };
      assertCurrent();
      const response = await deps.confirm(window, {
        type: "warning",
        title: "创建 Issue 批次",
        message: `批准固定的 ${items.length} 项 Issue 清单？`,
        detail: `${connection.label}\n\n${JSON.stringify(items, null, 2)}\n\n每项仍需现有写入审批和独立回读。失败、取消或结果未知时立即停止；关闭或重启后不会续写。`,
        buttons: ["取消", "批准固定清单"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      assertCurrent();
      if (response.response !== 1) return { status: "cancelled" };
      if (
        deps.isSessionRunning(sessionId) ||
        readOperationSessionOwner(deps.root, sessionId).state.status === "active"
      )
        throw new Error("Session started while Native confirmation was open");
      assertCurrent();
      const token = randomUUID(),
        origin = randomUUID();
      const batch = createGithubIssueBatch({
        root: deps.root,
        sessionId,
        originIntent: origin,
        connection,
        items,
        assertCurrent,
      });
      permit = {
        token,
        origin,
        sessionId,
        connectionId: connection.id,
        batch,
        check: assertCurrent,
        closed: false,
      };
      permits.set(token, permit);
      const admitted = permit;
      // The secret nonce rides only the dedicated Main request. Task text carries no authority.
      void bridge
        .requestOperationBatchRun(
          {
            sessionId,
            cwd: current.target.cwd,
            requireExisting: true,
            clientMessageId: origin,
            disableGoal: true,
            task: `执行用户在 Native 确认的固定 GitHub Issue 清单。按顺序通过 LinkAction 创建，每项 verified 后再下一项；错误或未知立即停止。不得修改参数、替换连接或增加项。connectionId=${connection.id}\n${JSON.stringify(items)}`,
            displayText: `已批准创建 ${items.length} 项 GitHub Issue（固定清单）`,
          },
          token,
          () => {
            if (admitted.closed) throw new Error("Batch closed before admission");
            assertCurrent();
          },
        )
        .catch(() => undefined)
        .finally(() => {
          try {
            close(admitted);
          } catch {
            /* Retain closed permit; restart still has no authority. */
          }
        });
      return { status: "started", count: items.length };
    } finally {
      if (!permit) sessions.delete(sessionId);
    }
  });
  return async () => {
    disposed = true;
    for (const bridge of bridges) bridge.setOperationBatchResolver(undefined);
    deps.ipc.removeHandler("operationBatch:options");
    deps.ipc.removeHandler("operationBatch:start");
    for (const permit of permits.values()) close(permit);
  };
}
