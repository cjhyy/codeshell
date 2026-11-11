import {
  ExternalRuntimeApprovals,
  type ExternalApprovalEvent,
} from "./external-runtime-approvals.js";
import { ExternalRuntimeMemory } from "./external-runtime-memory.js";
import {
  ExternalRuntimeService,
  type ExternalRuntimeServiceDeps,
} from "./external-runtime-service.js";
import { dlog } from "./desktop-logger.js";
import type { DesktopModule } from "./desktop-shutdown.js";

interface ExternalRuntimeModuleOptions {
  approvals: ConstructorParameters<typeof ExternalRuntimeApprovals>[0];
  service: Omit<ExternalRuntimeServiceDeps, "memory" | "requestApproval" | "cancelApprovals">;
}

interface ExternalRuntimeModule extends DesktopModule {
  readonly service: ExternalRuntimeService | null;
  readonly approvals: ExternalRuntimeApprovals | null;
  /**
   * Hear every approval prompt appear and retire, from the current router and
   * any later one (the module may start after the listener subscribes).
   */
  subscribeApprovals(listener: (event: ExternalApprovalEvent) => void): () => void;
}

/**
 * Own the external runtime domain without starting it during module registration.
 * Main supplies the authority callbacks when the first window has created its bridge.
 */
export function createExternalRuntimeModule(
  options: () => ExternalRuntimeModuleOptions,
): ExternalRuntimeModule {
  let service: ExternalRuntimeService | null = null;
  let approvals: ExternalRuntimeApprovals | null = null;
  const approvalListeners = new Set<(event: ExternalApprovalEvent) => void>();
  return {
    name: "external-runtime",
    get service() {
      return service;
    },
    get approvals() {
      return approvals;
    },
    subscribeApprovals(listener) {
      // A wrapper per subscription, so subscribing one listener twice is two subscriptions.
      const entry = (event: ExternalApprovalEvent) => listener(event);
      approvalListeners.add(entry);
      return () => approvalListeners.delete(entry);
    },
    start() {
      const deps = options();
      const runtimeApprovals = new ExternalRuntimeApprovals(deps.approvals);
      // One observer for every listener, present and later; each is isolated.
      runtimeApprovals.subscribe((event) => {
        for (const listener of [...approvalListeners]) {
          try {
            listener(event);
          } catch (error) {
            dlog("external-runtime", "approval.observer_failed", {
              requestId: event.requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
      approvals = runtimeApprovals;
      service = new ExternalRuntimeService({
        ...deps.service,
        memory: new ExternalRuntimeMemory(),
        requestApproval: (sessionId, request) => runtimeApprovals.request(sessionId, request),
        cancelApprovals: (sessionId) => runtimeApprovals.cancelSession(sessionId),
      });
    },
    dispose() {
      // Stop captured children before clearing the publicly reachable service, as Main did.
      // The service retains its approval callbacks until its sessions finish closing.
      const shutdown = service?.stopAll();
      service = null;
      return shutdown;
    },
  };
}
