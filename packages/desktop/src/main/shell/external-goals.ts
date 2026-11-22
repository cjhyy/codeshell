import type { BrowserWindow } from "electron";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import { assertDesktopSessionId } from "../session-validation.js";
import {
  createExternalGoalRpcHandler,
  isExternalGoalRequest,
  type ExternalGoalRpcHandler,
} from "../external-runtime-goal-rpc.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";
import { assertOutputHistoryWriteAvailable } from "../session-output-history-lease.js";

export function nativeExternalGoals(deps: {
  window(id: number): BrowserWindow | undefined;
  ownsMimiDocument(id: number, sessionId: string): boolean;
  documentSignal(window: BrowserWindow): AbortSignal;
  watchOwner(id: string, ownerId: number): { signal: AbortSignal; release(): void };
  call: CallShellBusiness;
  runtime(): ExternalRuntimeService | null;
  hasWorker(): boolean;
  onGoalRead(id: string): void;
}): ExternalGoalRpcHandler {
  return (request, ownerId, checkDocument) => {
    if (!isExternalGoalRequest(request)) return;
    return (async () => {
      const sessionId = request.params?.sessionId;
      assertDesktopSessionId(sessionId);
      const window = deps.window(ownerId);
      if (!window) {
        if (!deps.ownsMimiDocument(ownerId, sessionId))
          throw Error("Goal controls require a live workbench");
        const record = await deps.call("goals/read", { sessionId });
        checkDocument?.();
        if (
          record.external ||
          deps.runtime()?.get(sessionId) ||
          !deps.ownsMimiDocument(ownerId, sessionId)
        )
          throw Error("External Goal controls require a workbench");
        if (request.method === "agent/goalGet" && !deps.hasWorker())
          return { jsonrpc: "2.0", id: request.id, result: record.goal };
        return undefined;
      }
      const document = deps.documentSignal(window);
      const lease = deps.watchOwner(sessionId, ownerId);
      const signal = AbortSignal.any([document, lease.signal]);
      const service = deps.runtime();
      const check = () => {
        signal.throwIfAborted();
        checkDocument?.();
        if (window.isDestroyed() || deps.runtime() !== service)
          throw Error("Goal authority changed");
        assertOutputHistoryWriteAvailable(sessionId);
      };
      try {
        check();
        const live = service?.get(sessionId);
        const cold = live ? undefined : await deps.call("goals/read", { sessionId }, signal);
        check();
        if (cold && !cold.external && !service?.get(sessionId)) {
          // A durable native Goal remains visible when no stdio worker is running.
          if (request.method === "agent/goalGet" && !deps.hasWorker())
            return { jsonrpc: "2.0", id: request.id, result: cold.goal };
          return undefined;
        }
        if (!service) throw Error("External runtime service unavailable");
        if (request.method === "agent/goalGet" && cold && !service.get(sessionId)) {
          deps.onGoalRead(sessionId);
          check();
          return { jsonrpc: "2.0", id: request.id, result: cold.goal };
        }
        const handler = createExternalGoalRpcHandler({
          isExternalSession: () => true,
          authorize: check,
          onGoalRead: deps.onGoalRead,
          service: () => ({
            getGoal: async (id, caller) => {
              if (service.get(id)) return service.getGoal(id, caller);
              const snapshot = await deps.call("goals/read", { sessionId: id }, signal);
              check();
              if (!snapshot.external) throw Error("External task runtime changed");
              return snapshot.goal;
            },
            updateGoal: service.updateGoal.bind(service),
            deleteGoal: service.deleteGoal.bind(service),
            extendGoal: service.extendGoal.bind(service),
          }),
          async prepareResume(id, caller) {
            if (service.canResumeGoal(id, caller)) return;
            const initial = await deps.call(
              "goals/resume",
              { sessionId: id, includeContext: true },
              signal,
            );
            check();
            const model = parseExternalRuntimeModelKey(initial.modelKey);
            if (!model) throw Error("External goal model unavailable");
            let projectBound = initial.projectBound;
            await service.ensure({
              kind: model.kind,
              sessionId: id,
              modelKey: initial.modelKey,
              ...(model.model ? { model: model.model } : {}),
              cwd: initial.cwd,
              mainRoot: initial.mainRoot,
              initialContext: initial.initialContext,
              permissionMode: "default",
              hasGoal: true,
              ownerWindow: window,
              assertStartAuthority: check,
              async refreshStartAuthority() {
                const current = await deps.call(
                  "goals/resume",
                  { sessionId: id, includeContext: false },
                  signal,
                );
                if (
                  current.identity !== initial.identity ||
                  (projectBound && !current.projectBound)
                )
                  throw Error("External goal Session changed before startup");
                projectBound = current.projectBound;
              },
            });
          },
        });
        return await handler(request, ownerId, check);
      } finally {
        lease.release();
      }
    })();
  };
}
