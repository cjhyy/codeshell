import type { BrowserWindow } from "electron";
import { SessionManager, type GoalConfig, type PermissionMode } from "@cjhyy/code-shell-core";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";
import { parseExternalRuntimeModelKey } from "../shared/external-runtime-models.js";
import {
  persistedExternalRuntimeModelKey,
  isPersistedExternalRuntime,
} from "./mobile-remote/external-runtime-commands.js";
import type { ExternalRuntimeService } from "./external-runtime-service.js";
import { buildExternalRuntimeHandoffFromEvents } from "./external-runtime-handoff.js";
import { resolveExternalRuntimeStartWorkspace } from "./external-runtime-start-workspace.js";
import { getSessionEvents } from "./rawTranscript.js";
import { assertDesktopSessionId } from "./session-validation.js";

/** Main-originated IM/delegation submissions keep their selected provider. */
export function createExternalRuntimeHostSubmission(deps: {
  service(): ExternalRuntimeService | null;
  ownerWindow(sessionId: string): BrowserWindow | undefined;
  sessions?: SessionManager;
  resolveStartWorkspace?: (
    sessionId: string,
    requestedCwd: unknown,
  ) => ReturnType<typeof resolveExternalRuntimeStartWorkspace>;
}) {
  const sessions = deps.sessions ?? new SessionManager();
  const resolveStartWorkspace =
    deps.resolveStartWorkspace ??
    ((sessionId, requestedCwd) =>
      resolveExternalRuntimeStartWorkspace(sessionId, requestedCwd, { sessions }));
  async function run(params: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
    try {
      const sessionId = params.sessionId;
      assertDesktopSessionId(sessionId);
      const service = deps.service();
      if (!service) throw new Error("外部运行时尚未就绪，未切换到 API 模型。");
      const state = sessions.readSessionState(sessionId);
      const modelKey =
        typeof params.model === "string" ? params.model : persistedExternalRuntimeModelKey(state);
      const parsed = parseExternalRuntimeModelKey(modelKey);
      if (!parsed?.model) throw new Error("外部会话的模型配置无效，未切换到 API 模型。");
      if (params.requireExisting && !state) throw new Error("原工作会话不存在。");
      const requestedCwd = state?.cwd ?? params.cwd;
      if (typeof requestedCwd !== "string" || !requestedCwd) throw new Error("工作目录不可用。");
      // Admission must be durable before the Gateway acknowledges it. Until a
      // cross-process external queue is available, refuse a busy bound session
      // explicitly rather than acknowledge a memory-only queued provider call.
      if (service.isSessionRunning(sessionId))
        throw new Error("当前外部会话仍在运行，请等待本轮结束后重试；未切换到 API 模型。");
      const workspace = await resolveStartWorkspace(sessionId, requestedCwd);
      const ownerWindow = deps.ownerWindow(sessionId);
      const assertCurrent = () => {
        workspace.assertStartAuthority();
        if (deps.service() !== service || ownerWindow?.isDestroyed())
          throw new Error("会话运行环境已改变，请重试。");
        const current = sessions.readSessionState(sessionId);
        if (state) {
          if (
            !current ||
            current.cwd !== state.cwd ||
            current.startedAt !== state.startedAt ||
            persistedExternalRuntimeModelKey(current) !== persistedExternalRuntimeModelKey(state)
          )
            throw new Error("会话模型或工作目录已改变，请重试。");
        } else if (current && persistedExternalRuntimeModelKey(current) !== modelKey) {
          throw new Error("会话模型或工作目录已改变，请重试。");
        }
      };
      assertCurrent();
      const initialContext = buildExternalRuntimeHandoffFromEvents(
        await getSessionEvents(sessionId, undefined, sessions.getStorageDir()),
      );
      await service.ensureContinuation({
        kind: parsed.kind,
        sessionId,
        cwd: workspace.cwd,
        mainRoot: workspace.mainRoot,
        modelKey,
        model: parsed.model,
        ...(typeof params.permissionMode === "string"
          ? { permissionMode: params.permissionMode as PermissionMode }
          : {}),
        ...(typeof params.planMode === "boolean" ? { planMode: params.planMode } : {}),
        ...(typeof params.workspaceProfile === "string"
          ? { workspaceProfile: params.workspaceProfile }
          : {}),
        ...(ownerWindow ? { ownerWindow } : {}),
        ...(initialContext ? { initialContext } : {}),
        assertStartAuthority: assertCurrent,
      });
      assertCurrent();
      const text = typeof params.task === "string" ? params.task : "";
      if (!text.trim()) throw new Error("消息不能为空。");
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as InputAttachmentMeta[]).map((attachment) => ({
            path: attachment.absPath,
            kind: attachment.kind === "image" ? ("image" as const) : ("file" as const),
            ...(attachment.mime ? { mime: attachment.mime } : {}),
          }))
        : [];
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (result: { ok: boolean; message?: string }) => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        void service
          .send(
            sessionId,
            {
              text,
              ...(typeof params.displayText === "string"
                ? { displayText: params.displayText }
                : {}),
              ...(typeof params.clientMessageId === "string"
                ? { clientMessageId: params.clientMessageId }
                : {}),
              ...(attachments.length ? { attachments } : {}),
              ...(params.goal ? { goal: params.goal as string | GoalConfig } : {}),
              ...(params.disableGoal === true ? { disableGoal: true } : {}),
              modelTraceSource: "im-work-external",
            },
            undefined,
            params.goalContinuation as { goalId: string; revision: number } | undefined,
            {
              beforeInput: async () => {
                assertCurrent();
              },
              accepted: () => finish({ ok: true }),
            },
          )
          .then(
            (result) => finish({ ok: result.ok, ...(result.text ? { message: result.text } : {}) }),
            (error) =>
              finish({
                ok: false,
                message: error instanceof Error ? error.message : String(error),
              }),
          );
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    run,
    isExternal: (sessionId: string) => {
      const state = sessions.readSessionState(sessionId);
      return state ? isPersistedExternalRuntime(state) : !!deps.service()?.get(sessionId);
    },
    isRunning: (sessionId: string) => deps.service()?.isSessionRunning(sessionId) ?? false,
    async runBound(input: { sessionId: string; text: string; clientMessageId: string }) {
      const result = await run({
        ...input,
        task: input.text,
        displayText: input.text,
        requireExisting: true,
      });
      return { started: result.ok, ...(result.message ? { reason: result.message } : {}) };
    },
    async stop(sessionId: string) {
      const service = deps.service();
      if (!service) throw new Error("外部运行时尚未就绪。");
      await service.stop(sessionId);
    },
  };
}
