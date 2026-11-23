import { BrowserWindow } from "electron";
import { ErrorCodes, type SessionManager } from "@cjhyy/code-shell-core";
import {
  AgentRunMetadataError,
  prepareAgentRunMetadata,
  type AgentRunMetadataDeps,
} from "../agent-run-metadata.js";
import { captureRendererRunFacts, type RendererRunFacts } from "./renderer-run-facts.js";
import type { WorkbenchAdmission } from "./ingress-wire.js";
import type { DesktopWorkerDriver } from "./worker-wire.js";
import type { QuickChatForkRouter, QuickChatForkLifecycle } from "../quick-chat-fork-router.js";
import {
  buildNoChildFallbackReply,
  forkSourceSessionId,
  compactQuerySessionId,
  goalResumeSessionId,
  quickChatForkRequest,
  quickChatRunRequest,
  quickChatRunSessionId,
} from "../agent-bridge-fallback.js";
import { assertOutputHistoryWriteAvailable } from "../session-output-history-lease.js";
import { observeRunStopFrame } from "../run-stop-signals.js";
import {
  cancelBrowserActionsForStoppedRun,
  beginBrowserRunForStartedRun,
} from "../browser-runtime/index.js";
import { observeComputerUseRunControl } from "../computer-use/service.js";
import { getSessionCwdIndex } from "../session-cwd-index.js";
import { isOptimizationLabQuery } from "../../shared/optimization-lab.js";
import { dlog } from "../desktop-logger.js";
import {
  isExternalGoalRequest,
  type ExternalGoalRpcHandler,
} from "../external-runtime-goal-rpc.js";
import type { WebConfigurationGate } from "../web-configuration-gate.js";

export interface DirectAdmission {
  facts: RendererRunFacts;
  assertCurrent(): void;
  reply(admission: WorkbenchAdmission): void;
}
interface RendererCommandDeps {
  agentRunMetadataDeps(): AgentRunMetadataDeps;
  claimSessionPanelOwner(sessionId: string, id: number): void;
  core: DesktopWorkerDriver;
  externalGoalRpcHandler?: ExternalGoalRpcHandler;
  handleAgentRunMetadata(prepared: ReturnType<typeof prepareAgentRunMetadata>): string;
  publishFallbackReply(line: string): void;
  quickChatForkLifecycle?: QuickChatForkLifecycle;
  quickChatForkRouter: QuickChatForkRouter | null;
  safeSend(channel: string, payload: unknown): void;
  sessionMainRootMigrationClaims: ReadonlyMap<string, string>;
  sessionsForFallback(): SessionManager;
  tentativeRunsByRequest: Map<string, string>;
  webConfiguration: WebConfigurationGate;
  windows: ReadonlySet<BrowserWindow>;
  workerGeneration(): number;
}

export async function handleRendererCommand(
  deps: RendererCommandDeps,
  sender: BrowserWindow["webContents"],
  line: string,
  direct?: DirectAdmission,
) {
  const target = direct
    ? {
        id: sender.id,
        isDestroyed: () => sender.isDestroyed(),
        send: (_channel: string, data: string) => {
          direct.assertCurrent();
          const response = JSON.parse(data);
          direct.reply({
            type: "reply",
            ...(response.error ? { error: response.error } : { result: response.result }),
          });
        },
      }
    : sender;

  // Inspect the message: an agent/run is the only one that can trigger
  // a fresh spawn. Other messages (agent/approve, agent/cancel) only
  // make sense if the worker is already alive.
  let prepared: ReturnType<typeof prepareAgentRunMetadata>;
  try {
    prepared = prepareAgentRunMetadata(
      line,
      { origin: "renderer", producer: "agent:msg" },
      direct
        ? captureRendererRunFacts(deps.agentRunMetadataDeps(), direct.facts)
        : deps.agentRunMetadataDeps(),
    );
  } catch (error) {
    if (error instanceof AgentRunMetadataError) {
      let id: unknown;
      try {
        id = (JSON.parse(line) as { id?: unknown }).id;
      } catch {
        id = undefined;
      }
      if (id !== undefined && !sender.isDestroyed()) {
        target.send(
          "agent:msg",
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: error.code, message: error.message },
          }),
        );
      }
      return;
    }
    throw error;
  }
  const parsed = prepared.parsed;
  if (direct) direct.assertCurrent();
  if (typeof parsed.params?.sessionId === "string") {
    try {
      assertOutputHistoryWriteAvailable(parsed.params.sessionId);
    } catch {
      if (parsed.id !== undefined && !sender.isDestroyed())
        target.send(
          "agent:msg",
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: {
              code: ErrorCodes.Overloaded,
              message: "Session output recovery is in progress",
            },
          }),
        );
      return;
    }
  }
  observeRunStopFrame(parsed);
  cancelBrowserActionsForStoppedRun(parsed);
  beginBrowserRunForStartedRun(parsed);
  observeComputerUseRunControl(parsed);
  if (isOptimizationLabQuery(parsed)) {
    if (parsed.id !== undefined && !sender.isDestroyed()) {
      target.send(
        "agent:msg",
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: {
            code: -32601,
            message: "Optimization Lab requires the dedicated local application bridge",
          },
        }),
      );
    }
    return;
  }
  if (deps.externalGoalRpcHandler && isExternalGoalRequest(parsed)) {
    const frame = sender.mainFrame;
    const sameDocument = () =>
      !sender.isDestroyed() && !frame.isDestroyed() && sender.mainFrame === frame;
    const checkDocument = () => {
      if (!sameDocument()) throw Error("Workbench document changed");
      direct?.assertCurrent();
    };
    try {
      const reply = await deps.externalGoalRpcHandler(parsed, sender.id, checkDocument);
      checkDocument();
      if (reply) {
        if (parsed.id !== undefined) target.send("agent:msg", JSON.stringify(reply));
        return;
      }
    } catch {
      const error = { code: -32003, message: "Goal authority changed or storage is unavailable" };
      if (direct) direct.reply({ type: "reply", error });
      else if (sameDocument() && parsed.id !== undefined)
        target.send("agent:msg", JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error }));
      return;
    }
  }
  if (
    parsed.method === "agent/run" &&
    (deps.webConfiguration.runBlocked ||
      (prepared.sessionId && deps.sessionMainRootMigrationClaims.has(prepared.sessionId)))
  ) {
    if (parsed.id !== undefined && !sender.isDestroyed()) {
      target.send(
        "agent:msg",
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: {
            code: ErrorCodes.Overloaded,
            message: deps.webConfiguration.runBlocked
              ? "配置正在更新，请稍后重试。"
              : `Session ${prepared.sessionId} root migration is in progress; retry the run`,
          },
        }),
      );
    }
    return;
  }
  // Line forwarded to the worker. Only rewritten when we inject fields
  // (agent/run trust) — everything else is passed through verbatim so we
  // don't re-serialize on the hot path.
  let outLine = line;
  const quickChatRunId = quickChatRunSessionId(parsed);
  if (quickChatRunId) {
    const request = quickChatRunRequest(parsed, sender.id);
    if (!request || deps.quickChatForkLifecycle?.isClaimActive?.(request) !== true) {
      if (parsed.id !== undefined && !sender.isDestroyed()) {
        target.send(
          "agent:msg",
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32602, message: "quick-chat claim is no longer active" },
          }),
        );
      }
      return;
    }
  }
  const quickChatFork = quickChatForkRequest(parsed, sender.id);
  let quickChatForkWireId: string | undefined;
  if (quickChatFork && deps.quickChatForkRouter) {
    const started = deps.quickChatForkRouter.start(quickChatFork, target, line);
    if (!started) return;
    outLine = started.line;
    quickChatForkWireId = started.wireId;
  }

  if (parsed.method === "agent/run") {
    outLine = deps.handleAgentRunMetadata(prepared);
    const owner = BrowserWindow.fromWebContents(sender);
    if (prepared.sessionId && owner && deps.windows.has(owner)) {
      // The renderer-driven case. Sessions driven from elsewhere (main-owned,
      // external Agent Runtime) never reach this line and must claim
      // ownership explicitly — same method, so there is one code path.
      deps.claimSessionPanelOwner(prepared.sessionId, sender.id);
    }
  } else {
    const forkSourceId = forkSourceSessionId(parsed);
    if (forkSourceId) {
      deps.core.ensureWorker(deps.sessionsForFallback().readSessionMainRoot(forkSourceId));
    }
    const compactSessionId = compactQuerySessionId(parsed);
    if (compactSessionId) {
      deps.core.ensureWorker(
        deps.sessionsForFallback().readSessionMainRoot(compactSessionId) ?? parsed.params?.cwd,
      );
    }
    const goalResumeId = goalResumeSessionId(parsed);
    if (goalResumeId) {
      deps.core.ensureWorker(deps.sessionsForFallback().readSessionMainRoot(goalResumeId));
    }
  }

  if (!deps.core.canSend()) {
    if (parsed.method === "agent/run" && prepared.sessionId) {
      getSessionCwdIndex().evictTentative(prepared.sessionId);
      if (prepared.parsed.id !== undefined) {
        deps.tentativeRunsByRequest.delete(String(prepared.parsed.id));
      }
    }
    // No live worker. For approve / cancel this is fine — drop.
    // For run, ensureWorker above should have created one; if it
    // didn't, log and drop.
    // BUT some requests must still get a REPLY, or the renderer's rpc()
    // hangs its 30s timeout: read-only registry queries (backgroundShells /
    // backgroundWork — the in-RAM registry is gone with the worker) and
    // disk-backed goal ops (goalGet / goalClear — a persistent goal lives
    // in state.json and outlives the worker; without this the "Clear goal"
    // button did nothing for an aborted goal session).
    const fallback = buildNoChildFallbackReply(parsed, deps.sessionsForFallback());
    if (fallback !== null) {
      if (direct) target.send("agent:msg", fallback);
      else deps.publishFallbackReply(fallback);
    }
    dlog("bridge", "renderer→worker.dropped", {
      reason: deps.core.hasChild() ? "stdin destroyed" : "no child",
      method: parsed.method,
      answered: fallback !== null,
    });
    if (quickChatForkWireId) {
      void deps.quickChatForkRouter
        ?.fail(quickChatForkWireId)
        .catch((error) =>
          dlog("bridge", "quick_chat.fork_settle_failed", { error: String(error) }),
        );
    }
    if (direct && fallback === null)
      direct.reply({
        type: "reply",
        error: { code: -32002, message: "Agent worker is unavailable" },
      });
    return;
  }
  dlog("bridge", "renderer→worker", { method: parsed.method, sessionId: parsed.params?.sessionId });
  if (direct) {
    direct.assertCurrent();
    const wireId = JSON.parse(outLine).id;
    direct.reply({
      type: "dispatch",
      id: wireId,
      generation: deps.workerGeneration(),
      ...(parsed.method === "agent/run" ? { facts: direct.facts } : {}),
    });
    return;
  }
  try {
    if (!deps.core.sendLine(outLine) && parsed.id !== undefined) {
      deps.webConfiguration.settleRun(parsed.id);
    }
  } catch (error) {
    if (parsed.id !== undefined) {
      deps.webConfiguration.settleRun(parsed.id);
      deps.safeSend(
        "agent:msg",
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: { code: -32603, message: "无法向任务进程发送请求，请重试。" },
        }),
      );
    }
    dlog("bridge", "renderer.write_failed", { error: String(error) });
  }
}
