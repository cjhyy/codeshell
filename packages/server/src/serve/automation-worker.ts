import { randomUUID } from "node:crypto";
import type { CronJob, CronRunRequest } from "@cjhyy/code-shell-core/internal";
import { WorkerBridgeCore } from "../worker-bridge-core.js";
import {
  HubAutomationUncertainError,
  HubAutomationCancelledError,
} from "../panels/hub-automations.js";

export interface HubAutomationWorkerOptions {
  bridge: WorkerBridgeCore;
  cwd: string;
  /** Must synchronously exclude other runs/configuration changes until release. */
  reserve(job: CronJob, requestId: string): () => void;
  model(): string | undefined;
  admissionTimeoutMs?: number;
}

/** Borrows the project's live Worker so persisted Session state has one writer. */
export function createHubAutomationWorker(options: HubAutomationWorkerOptions) {
  const active = new Map<
    string,
    { request: CronRunRequest; requestId: string; approvals: Set<string> }
  >();
  const rpc = (method: string, params: unknown, id = `automation-control-${randomUUID()}`) =>
    options.bridge.request(method, params, {
      id,
      consume: true,
      settleOnExit: true,
      failFast: true,
      timeoutMs: 5000,
      meta: { origin: "host", producer: "hub-automation" },
    });

  /** Called before the interactive approval lease router. */
  function handleApproval(params: Record<string, any>): boolean {
    const entry = active.get(params.sessionId);
    if (!entry) return false;
    if (
      typeof params.requestId !== "string" ||
      !params.request ||
      typeof params.request.toolName !== "string"
    )
      return true;
    if (entry.approvals.has(params.requestId)) return true;
    entry.approvals.add(params.requestId);
    void (async () => {
      const request = params.request as Parameters<
        CronRunRequest["approvalBackend"]["requestApproval"]
      >[0];
      const decision = request.toolName.startsWith("__")
        ? {
            approved: false,
            failure: "unavailable",
            reason: "Unattended runs cannot use a page-owned capability",
          }
        : await entry.request.approvalBackend.requestApproval(request);
      if (active.get(params.sessionId) !== entry || entry.request.signal?.aborted) return;
      const outcome = await rpc("agent/approve", {
        sessionId: params.sessionId,
        requestId: params.requestId,
        connectionId: params.connectionId,
        generation: params.generation,
        decision,
      });
      if (outcome.status !== "result" && active.get(params.sessionId) === entry) {
        await rpc("agent/cancel", { sessionId: params.sessionId });
      }
    })().catch(async () => {
      if (active.get(params.sessionId) === entry)
        await rpc("agent/cancel", { sessionId: params.sessionId });
    });
    return true;
  }

  async function execute(request: CronRunRequest): Promise<void> {
    request.signal?.throwIfAborted();
    const sessionId = request.job.resumeSessionId;
    if (!sessionId || request.job.cwd !== options.cwd || !request.job.lastRunId)
      throw Error("Automation requires a persisted run identity and project Session");
    if (active.has(sessionId)) throw Error("The Session already has an active automation");
    const requestId = `automation-run-${request.job.lastRunId}`;
    const release = options.reserve(request.job, requestId);
    const entry = { request, requestId, approvals: new Set<string>() };
    active.set(sessionId, entry);
    let cancel: (() => void) | undefined;
    try {
      const model = options.model();
      if (!model) throw Error("Configure a default text model before running automations");
      request.signal?.throwIfAborted();
      const result = options.bridge.request(
        "agent/run",
        {
          sessionId,
          cwd: options.cwd,
          task: request.prompt,
          model,
          requireExisting: true,
          clientMessageId: requestId,
          displayText: request.prompt,
          disableGoal: true,
          permissionMode: request.permissionMode,
          sandboxMode: request.sandboxMode,
          allowBackgroundShells: false,
        },
        {
          id: requestId,
          timeoutMs: options.admissionTimeoutMs ?? 60000,
          consume: true,
          settleOnExit: true,
          failFast: true,
          waitForRunCompletion: true,
          ensureWorker: true,
          ensureWorkerCwd: options.cwd,
          meta: { origin: "host", producer: "hub-automation" },
        },
      );
      cancel = () => {
        void rpc("agent/cancel", { sessionId });
      };
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();
      const outcome = await result;
      if (outcome.status === "timeout" || outcome.status === "sendFailed") {
        // Admission may have reached the child despite a lost ACK/write error.
        // Never release the Session based only on a local transport timeout.
        await options.bridge.stopAndWait();
        throw new HubAutomationUncertainError(
          "Worker admission was not confirmed; inspect results before resuming",
        );
      }
      if (outcome.status === "workerExit")
        throw new HubAutomationUncertainError(
          "Worker exited before recording the automation outcome",
        );
      if (outcome.status === "error")
        throw Error(outcome.error.message ?? "Automation Worker rejected the run");
      const value = outcome.result as { reason?: string } | undefined;
      if (request.signal?.aborted) return;
      if (value?.reason === "aborted_streaming" || value?.reason === "aborted_tools")
        throw new HubAutomationCancelledError("Automation was cancelled");
      if (value?.reason !== "completed")
        throw Error(`Automation ended without completion (${value?.reason ?? "unknown"})`);
    } finally {
      if (cancel) request.signal?.removeEventListener("abort", cancel);
      active.delete(sessionId);
      release();
    }
  }
  return { execute, handleApproval, ownsSession: (sessionId: string) => active.has(sessionId) };
}
