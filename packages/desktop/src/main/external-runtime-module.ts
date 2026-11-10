import { ExternalRuntimeApprovals } from "./external-runtime-approvals.js";
import { ExternalRuntimeMemory } from "./external-runtime-memory.js";
import {
  ExternalRuntimeService,
  type ExternalRuntimeServiceDeps,
} from "./external-runtime-service.js";
import type { DesktopModule } from "./desktop-shutdown.js";

interface ExternalRuntimeModuleOptions {
  approvals: ConstructorParameters<typeof ExternalRuntimeApprovals>[0];
  service: Omit<ExternalRuntimeServiceDeps, "memory" | "requestApproval" | "cancelApprovals">;
}

interface ExternalRuntimeModule extends DesktopModule {
  readonly service: ExternalRuntimeService | null;
  readonly approvals: ExternalRuntimeApprovals | null;
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
  return {
    name: "external-runtime",
    get service() {
      return service;
    },
    get approvals() {
      return approvals;
    },
    start() {
      const deps = options();
      const runtimeApprovals = new ExternalRuntimeApprovals(deps.approvals);
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
