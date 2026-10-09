import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from "electron";
import type { createLinkOperationReviewStore } from "@cjhyy/code-shell-core/internal";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type { ResolvedRendererConfigurationTarget } from "./renderer-configuration-authority.js";
import type {
  OperationResolutionReview,
  OperationResolutionResult,
  OperationReadResult,
} from "../shared/operation-resolution.js";

type OperationReviewStore = ReturnType<typeof createLinkOperationReviewStore>;

interface Deps {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  windows(): BrowserWindow[];
  enabled(): boolean;
  store: Pick<OperationReviewStore, "review" | "resolve"> &
    Partial<Pick<OperationReviewStore, "reconcile">>;
  resolveTarget(input: unknown): Promise<ResolvedRendererConfigurationTarget>;
  trusted(cwd: string): Promise<boolean>;
  trustedSync(cwd: string): boolean;
  /** Synchronous project/trust registry identity: fail closed on replacement or edits. */
  authorityRevision(): string;
  isSessionRunning(sessionId: string): boolean;
  confirm(window: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>;
}

function inputRecord(input: unknown, keys: string[]): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid operation review");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => typeof value[key] !== "string") ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid operation review");
  if (Object.values(value).some((value) => (value as string).length > 128))
    throw new Error("Invalid operation review");
  return value as Record<string, string>;
}

function rootIdentity(cwd: string): string {
  const info = lstatSync(cwd);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Operation project root is unavailable");
  return JSON.stringify([cwd, info.dev, info.ino]);
}

/** Native top-frame authority only; not registered as a worker/model/Web RPC method. */
export function registerOperationResolutionIpc(deps: Deps): () => void {
  type Snapshot = ReturnType<OperationReviewStore["review"]>;
  const previews = new Map<
    string,
    {
      window: BrowserWindow;
      frame: IpcMainInvokeEvent["senderFrame"];
      sessionId: string;
      snapshot: Snapshot;
      target: ResolvedRendererConfigurationTarget;
      authority: string;
      root: string;
      expiresAt: number;
    }
  >();
  const owner = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = deps
      .windows()
      .find((window) => !window.isDestroyed() && window.webContents === event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame || !deps.enabled())
      throw new Error("Operation review requires the application top frame");
    return window;
  };
  const handle = (
    channel: string,
    callback: (window: BrowserWindow, args: unknown[], check: () => void) => Promise<unknown>,
  ) => {
    deps.ipc.handle(channel, (event, ...args) => {
      const window = owner(event);
      const frame = event.senderFrame;
      const check = () => {
        if (owner(event) !== window || event.sender.mainFrame !== frame)
          throw new Error("Operation review originating frame changed");
      };
      return callback(window, args, check);
    });
  };
  const authority = async (sessionId: string, check: () => void) => {
    check();
    const revision = deps.authorityRevision();
    const target = await deps.resolveTarget({ sessionId });
    check();
    if (target.kind !== "session" || target.sessionId !== sessionId)
      throw new Error("Operation Session is unavailable");
    const trusted = await deps.trusted(target.cwd);
    check();
    if (!trusted || revision !== deps.authorityRevision())
      throw new Error("Operation project authority changed");
    if (deps.isSessionRunning(sessionId))
      throw new Error("Stop this Session before reviewing an uncertain write");
    return { target, authority: revision, root: rootIdentity(target.cwd) };
  };

  handle(
    "operationResolution:review",
    async (window, args, check): Promise<OperationResolutionReview> => {
      if (args.length !== 1) throw new Error("Invalid operation review");
      const { sessionId } = inputRecord(args[0], ["sessionId"]);
      const context = await authority(sessionId, check);
      const snapshot = deps.store.review(sessionId);
      if (snapshot.owner.state.status === "active")
        throw new Error("Stop this Session before reviewing an uncertain write");
      for (const [token, prior] of previews) {
        if (prior.window === window || prior.expiresAt <= Date.now()) previews.delete(token);
      }
      if (previews.size >= 8) throw new Error("Too many operation reviews");
      const reviewToken = randomUUID();
      previews.set(reviewToken, {
        window,
        frame: window.webContents.mainFrame,
        sessionId,
        snapshot,
        ...context,
        expiresAt: Date.now() + 60_000,
      });
      return { reviewToken, records: snapshot.records, truncated: snapshot.truncated };
    },
  );
  handle(
    "operationResolution:reconcile",
    async (window, args, check): Promise<OperationReadResult> => {
      if (args.length !== 1 || !deps.store.reconcile)
        throw new Error("Operation read review unavailable");
      const input = inputRecord(args[0], ["reviewToken", "operationId", "revision"]);
      const prior = previews.get(input.reviewToken);
      const record = prior?.snapshot.records.find(
        (record) =>
          record.id === input.operationId &&
          record.revision === input.revision &&
          record.canResolve,
      );
      if (
        !prior ||
        !record ||
        prior.window !== window ||
        prior.frame !== window.webContents.mainFrame ||
        prior.expiresAt <= Date.now()
      )
        throw new Error("Operation review expired or changed; refresh the activity record");
      previews.delete(input.reviewToken);
      const workspace = prior.snapshot.owner.state.workspace as { root?: unknown } | undefined;
      const cwd = typeof workspace?.root === "string" ? workspace.root : prior.target.cwd;
      const executionRoot = rootIdentity(cwd);
      const assertCurrent = () => {
        check();
        if (
          Date.now() > prior.expiresAt ||
          deps.isSessionRunning(prior.sessionId) ||
          !deps.trustedSync(prior.target.cwd) ||
          deps.authorityRevision() !== prior.authority ||
          rootIdentity(prior.target.cwd) !== prior.root ||
          rootIdentity(cwd) !== executionRoot
        )
          throw new Error("Operation Session or project changed; refresh the activity record");
      };
      assertCurrent();
      const confirmation = await deps.confirm(window, {
        type: "question",
        title: "独立只读核查 / Independent read-only review",
        message: "读取原资源的当前状态？ / Read the original resource's current state?",
        detail: `${record.service} / ${record.action}\n\n这是用户发起的独立 Host 只读核查，遵守当前项目设置、工具禁用和原连接授权；不会启动模型或重发写入。可能发送 get_repository / get_starred / get_issue 中最多两项固定读取。匹配当前状态不能证明原写入成功，原任务与未知阻断均不改变。证据不足时仍需人工核查。\n\nThis independent Host read uses current project settings, tool controls and the original connection grant. It starts no model and resends no write. At most two fixed get_repository / get_starred / get_issue reads may run. Matching current state does not prove the original write succeeded. The original Run and uncertainty barrier remain unchanged. Missing evidence still requires manual review.`,
        buttons: ["取消 / Cancel", "只读核查 / Read only"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      check();
      if (confirmation.response !== 1) return { status: "cancelled" };
      const current = await authority(prior.sessionId, check);
      if (
        JSON.stringify(current.target) !== JSON.stringify(prior.target) ||
        current.authority !== prior.authority ||
        current.root !== prior.root
      )
        throw new Error("Operation Session or project changed; refresh the activity record");
      assertCurrent();
      const observation = await deps.store.reconcile(
        prior.sessionId,
        prior.snapshot.owner,
        input.operationId,
        input.revision,
        {
          cwd,
          // The Desktop stdio Host configures full settings. Core intersects
          // credential access with the original prepared (or legacy) scope.
          settingsScope: "full",
          assertCurrent,
          approveRead: async (action, target) => {
            assertCurrent();
            const permission = await deps.confirm(window, {
              type: "question",
              title: "只读权限确认 / Read permission",
              message: `当前权限规则要求确认 ${action} / Current rules require approval for ${action}`,
              detail: `${target}\n\n仅允许本次固定读取，不保存权限，不扩展连接授权。 / Allow this fixed read once without saving a permission or expanding the connection grant.`,
              buttons: ["拒绝 / Deny", "允许本次读取 / Allow once"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            assertCurrent();
            return permission.response === 1;
          },
        },
      );
      assertCurrent();
      return { status: "observed", observation };
    },
  );
  handle(
    "operationResolution:resolve",
    async (window, args, check): Promise<OperationResolutionResult> => {
      if (args.length !== 1) throw new Error("Invalid operation resolution");
      const input = inputRecord(args[0], ["reviewToken", "operationId", "revision"]);
      const prior = previews.get(input.reviewToken);
      const record = prior?.snapshot.records.find(
        (record) =>
          record.id === input.operationId &&
          record.revision === input.revision &&
          record.canResolve,
      );
      if (
        !prior ||
        !record ||
        prior.window !== window ||
        prior.frame !== window.webContents.mainFrame ||
        prior.expiresAt <= Date.now()
      )
        throw new Error("Operation review expired or changed; refresh the activity record");
      // One native prompt per preview. Concurrent callers cannot acquire this capability twice.
      previews.delete(input.reviewToken);
      const assertCurrent = () => {
        check();
        if (
          Date.now() > prior.expiresAt ||
          deps.isSessionRunning(prior.sessionId) ||
          !deps.trustedSync(prior.target.cwd) ||
          deps.authorityRevision() !== prior.authority ||
          rootIdentity(prior.target.cwd) !== prior.root
        )
          throw new Error("Operation Session or project changed; refresh the activity record");
      };
      assertCurrent();
      const confirmation = await deps.confirm(window, {
        type: "warning",
        title: "外部写入人工处理 / Review uncertain write",
        message:
          "人工核查后接受这项操作的未知结果？ / Accept this uncertain result after your own review?",
        detail: `${record.service} / ${record.action}\n${new Date(record.createdAt).toISOString()}\n${record.hasReference ? "有原始引用 / Original reference recorded" : "缺少原始引用，请自行在服务商处核查 / No original reference; review at the provider yourself"}\n\n结果仍未知。本次处理不会发送任何服务商请求，也不会把原任务标为成功。只解除这项记录对本会话后续全新操作的阻断，其它未处理写入继续阻断。原操作永远不会重发。\n\nThe result remains unknown. This sends no provider request and does not mark the original task successful. It only releases this record's barrier for new user intents in this Session. Other unresolved writes still block. The original operation is never resent.`,
        buttons: ["取消 / Cancel", "接受未知结果 / Accept uncertainty"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      check();
      if (confirmation.response !== 1) return { status: "cancelled", result: "unknown" };
      const current = await authority(prior.sessionId, check);
      if (
        JSON.stringify(current.target) !== JSON.stringify(prior.target) ||
        current.authority !== prior.authority ||
        current.root !== prior.root
      )
        throw new Error("Operation Session or project changed; refresh the activity record");
      assertCurrent();
      deps.store.resolve(
        prior.sessionId,
        prior.snapshot.owner,
        input.operationId,
        input.revision,
        assertCurrent,
      );
      return { status: "resolved", result: "unknown" };
    },
  );
  return () => {
    previews.clear();
    deps.ipc.removeHandler("operationResolution:review");
    deps.ipc.removeHandler("operationResolution:resolve");
    deps.ipc.removeHandler("operationResolution:reconcile");
  };
}
