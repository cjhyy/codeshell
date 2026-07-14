import type { LLMConfig, StreamCallback, StreamEvent } from "../types.js";
import type { AgentPresetName } from "../preset/index.js";
import type { ModelPool } from "../llm/model-pool.js";
import type { SubAgentSpawner } from "../tool-system/context.js";
import type { EngineConfig } from "./types.js";
import type { ChildEngineRunner } from "./run-types.js";
import type { ChildEngineRuntime, EngineRunOptions } from "./run-types.js";
import type {
  ChildWriterLease,
  LiveChildControl,
  LiveChildState,
} from "../tool-system/builtin/agent-registry.js";
import {
  buildAgentDirectionMessage,
  notificationQueue,
  type DirectionAck,
  type DirectionEnvelope,
  type DirectionEnvelopeDraft,
} from "../tool-system/builtin/agent-notifications.js";
import { nanoid } from "nanoid";
import {
  defaultSandboxConfig,
  type SandboxConfig,
  type SandboxMode,
} from "../tool-system/sandbox/index.js";
import type { MCPServerConfig } from "../types.js";

export const NESTED_AGENT_TOOLS = ["Agent", "AgentStatus", "AgentCancel", "AgentSendInput"];

export function resolveChildLlm(
  modelKey: string | undefined,
  pool: ModelPool | undefined,
  parentLlm: LLMConfig,
): LLMConfig {
  if (modelKey && pool?.has(modelKey)) {
    const resolved = pool.resolveLLMConfig(modelKey);
    if (resolved) return resolved;
  }
  return parentLlm;
}

export function resolveChildToolScope(
  allowlist: string[] | undefined,
  parentDisabled: string[] | undefined,
  parentEnabled: string[] | undefined,
): { enabled?: string[]; disabled: string[] } {
  if (allowlist) {
    return {
      enabled: allowlist.filter((tool) => !NESTED_AGENT_TOOLS.includes(tool)),
      disabled: [...NESTED_AGENT_TOOLS],
    };
  }
  return {
    enabled: parentEnabled?.filter((tool) => !NESTED_AGENT_TOOLS.includes(tool)),
    disabled: Array.from(new Set([...(parentDisabled ?? []), ...NESTED_AGENT_TOOLS])),
  };
}

export function resolveChildSandbox(
  mode: SandboxMode | undefined,
  parent: SandboxConfig,
): SandboxConfig {
  if (mode === undefined) return parent;
  // Role definitions are project/plugin-authored capability constraints, not
  // an authority to weaken the user's effective run sandbox. Explicit native
  // backends are already fail-closed; keep them unchanged. `auto` may resolve
  // to an isolated backend, so it likewise cannot be downgraded to off/auto.
  if (parent.mode === "seatbelt" || parent.mode === "bwrap") return parent;
  if (parent.mode === "auto" && (mode === "off" || mode === "auto")) return parent;
  return { ...defaultSandboxConfig(mode), ...parent, mode };
}

export function resolveChildMcpServers(
  allowlist: string[] | undefined,
  parent: Record<string, MCPServerConfig> | undefined,
): Record<string, MCPServerConfig> | undefined {
  if (allowlist === undefined) return parent;
  const allowed = new Set(allowlist);
  return Object.fromEntries(Object.entries(parent ?? {}).filter(([name]) => allowed.has(name)));
}

export function wrapChildStream(
  destination: StreamCallback | undefined,
  agentId: string,
): StreamCallback | undefined {
  if (!destination) return undefined;
  return (event) => {
    if (
      event.type === "usage_update" ||
      event.type === "session_started" ||
      event.type === "context_compact"
    ) {
      return;
    }
    destination({ ...event, agentId } as StreamEvent);
  };
}

function wrapChildRuntimeStream(
  destination: StreamCallback | undefined,
  agentId: string,
  onProgressEvent?: (event: StreamEvent) => void,
): StreamCallback | undefined {
  const uiStream = wrapChildStream(destination, agentId);
  if (!uiStream && !onProgressEvent) return undefined;
  return (event) => {
    onProgressEvent?.(event);
    return uiStream?.(event);
  };
}

export interface CreateSubAgentSpawnerDeps {
  parentConfig: EngineConfig;
  /** Fully resolved sandbox for this parent run, including settings layers. */
  parentSandbox: SandboxConfig;
  presetName: AgentPresetName;
  cwd: string;
  permissionMode: NonNullable<EngineConfig["permissionMode"]>;
  modelPool?: ModelPool;
  appendParentSubagent: (agentId: string, description: string) => void;
  sessionExists: (sessionId: string) => boolean;
  getSessionParentId?: (sessionId: string) => string | null | undefined;
  childRunner: ChildEngineRunner;
  parentStream?: StreamCallback;
}

class ChildRunSupervisor implements LiveChildControl {
  readonly childSessionId: string;
  readonly runtimeGeneration: number;
  private state: LiveChildState = "starting";
  private activeController: AbortController | undefined;
  private interruptPending = false;
  private running = false;
  private intakeClosed = false;
  private pendingDelivered = new Map<
    string,
    {
      receipt: Omit<Exclude<DirectionAck, { status: "rejected" }>, "status">;
      resolve: (ack: DirectionAck) => void;
    }
  >();
  private closeIntake?: () => boolean | void;

  constructor(
    private readonly runtime: ChildEngineRuntime,
    childSessionId: string,
    runtimeGeneration: number,
  ) {
    this.childSessionId = childSessionId;
    this.runtimeGeneration = runtimeGeneration;
    runtime.setAgentControlStateListener((state) => {
      this.state = state;
    });
    runtime.setAgentDirectionsDeliveredListener?.((envelopeIds) => {
      for (const id of envelopeIds) {
        const pending = this.pendingDelivered.get(id);
        if (!pending) continue;
        this.pendingDelivered.delete(id);
        pending.resolve({ status: "delivered", ...pending.receipt });
      }
    });
  }

  setCloseIntake(closeIntake: () => boolean | void): void {
    this.closeIntake = closeIntake;
  }

  getState(): LiveChildState {
    return this.state;
  }

  routeDirection(draft: DirectionEnvelopeDraft): DirectionAck | Promise<DirectionAck> {
    if (
      !this.running ||
      this.intakeClosed ||
      this.state === "closing" ||
      this.state === "terminal"
    ) {
      return { status: "rejected", reason: "intake-closed", rejectedAt: Date.now() };
    }
    const envelope = notificationQueue.enqueue(draft);
    if (!envelope || envelope.kind !== "direction") {
      return { status: "rejected", reason: "invalid-request", rejectedAt: Date.now() };
    }
    const receipt = {
      envelopeId: envelope.id,
      sequence: envelope.sequence,
      correlationId: envelope.correlationId,
      target: envelope.to,
      acceptedAt: envelope.createdAt,
    };
    if (this.state === "safe-point") {
      return new Promise<DirectionAck>((resolve) => {
        this.pendingDelivered.set(envelope.id, { receipt, resolve });
      });
    }
    if (
      draft.delivery === "interrupt-and-redrive" &&
      !this.interruptPending &&
      this.activeController &&
      !this.activeController.signal.aborted
    ) {
      this.interruptPending = true;
      this.state = "interrupting";
      this.activeController.abort();
      return { status: "interrupted", ...receipt };
    }
    return { status: "queued", ...receipt };
  }

  private closeDirectionIntake(): void {
    if (this.intakeClosed) return;
    this.intakeClosed = true;
    this.state = "closing";
    this.closeIntake?.();
  }

  private drainDirections(): DirectionEnvelope[] {
    return notificationQueue.drain(
      this.childSessionId,
      (envelope) =>
        envelope.kind === "direction" && envelope.runtimeGeneration === this.runtimeGeneration,
    ) as DirectionEnvelope[];
  }

  async run(
    task: string,
    options: Pick<EngineRunOptions, "signal" | "onStream" | "sessionId" | "onAgentProgress">,
  ): Promise<Awaited<ReturnType<ChildEngineRuntime["run"]>>> {
    this.running = true;
    let nextTask = task;
    let agentDirection: EngineRunOptions["agentDirection"];
    try {
      for (;;) {
        const controller = new AbortController();
        this.activeController = controller;
        const lifecycleSignal = options.signal;
        const cascadeAbort = () => controller.abort();
        if (lifecycleSignal?.aborted) cascadeAbort();
        else lifecycleSignal?.addEventListener("abort", cascadeAbort, { once: true });
        this.state = agentDirection ? "redriving" : "starting";
        let result;
        try {
          result = await this.runtime.run(nextTask, {
            ...options,
            signal: controller.signal,
            runtimeGeneration: this.runtimeGeneration,
            ...(agentDirection ? { injected: true, agentDirection } : {}),
          });
        } finally {
          lifecycleSignal?.removeEventListener("abort", cascadeAbort);
          this.activeController = undefined;
        }
        if (lifecycleSignal?.aborted) {
          this.closeDirectionIntake();
          return result;
        }

        // Engine.run has fully settled here, including all accepted tool results.
        // For a normal completion, atomically close registry intake first. A
        // sender that won before this boundary is now in the fenced queue and
        // must be consumed/redriven; a sender after it is rejected.
        if (!this.interruptPending) this.closeDirectionIntake();
        const directions = this.drainDirections();
        this.interruptPending = false;
        if (directions.length === 0) {
          return result;
        }
        directions.sort((left, right) => left.sequence - right.sequence);
        nextTask = buildAgentDirectionMessage(directions);
        agentDirection = {
          envelopeIds: directions.map((item) => item.id),
          correlationIds: directions
            .map((item) => item.correlationId)
            .filter((value): value is string => value !== undefined),
        };
      }
    } finally {
      this.closeDirectionIntake();
      this.running = false;
      this.state = "terminal";
      for (const { receipt, resolve } of this.pendingDelivered.values()) {
        resolve({ status: "queued", ...receipt });
      }
      this.pendingDelivered.clear();
      this.runtime.setAgentControlStateListener(undefined);
      this.runtime.setAgentDirectionsDeliveredListener?.(undefined);
    }
  }
}

export function createSubAgentSpawner(deps: CreateSubAgentSpawnerDeps): SubAgentSpawner {
  return {
    parentStream: deps.parentStream,
    describe: () => ({
      cwd: deps.cwd,
      preset: deps.presetName,
      permissionMode: deps.permissionMode,
    }),
    sessionExists: deps.sessionExists,
    getSessionParentId: deps.getSessionParentId,
    spawn: async (request) => {
      if (!request.resumeSessionId) {
        try {
          deps.appendParentSubagent(request.agentId, request.description);
        } catch {
          // Parent anchors are best-effort and must never block a child run.
        }
      }

      const scope = resolveChildToolScope(
        request.toolAllowlist,
        deps.parentConfig.disabledBuiltinTools,
        deps.parentConfig.enabledBuiltinTools,
      );
      const childConfig: EngineConfig = {
        llm: resolveChildLlm(request.model, deps.modelPool, deps.parentConfig.llm),
        clientDefaults: {
          ...(deps.parentConfig.clientDefaults ?? {}),
          retryMaxAttempts: 2,
        },
        cwd: deps.cwd,
        permissionMode: deps.permissionMode,
        preset: deps.presetName,
        enabledBuiltinTools: scope.enabled,
        disabledBuiltinTools: scope.disabled,
        capabilities: deps.parentConfig.capabilities,
        builtinToolHost: deps.parentConfig.builtinToolHost,
        customSystemPrompt: deps.parentConfig.customSystemPrompt,
        appendSystemPrompt:
          [deps.parentConfig.appendSystemPrompt, request.appendSystemPrompt]
            .filter(Boolean)
            .join("\n\n") || undefined,
        responseLanguage: deps.parentConfig.responseLanguage,
        userProfile: deps.parentConfig.userProfile,
        instructions: deps.parentConfig.instructions,
        maxTurns: request.maxTurns,
        maxContextTokens: deps.parentConfig.maxContextTokens ?? 200_000,
        sessionStorageDir: deps.parentConfig.sessionStorageDir,
        headless: deps.parentConfig.headless,
        readOnlySession: request.readOnlySession,
        skillAllowlist: request.skillAllowlist,
        sandbox: resolveChildSandbox(request.sandboxMode, deps.parentSandbox),
        mcpServers: resolveChildMcpServers(request.mcpAllowlist, deps.parentConfig.mcpServers),
        settingsScope: deps.parentConfig.settingsScope ?? "project",
        isSubAgent: true,
      };
      const destination = request.streamOverride ?? deps.parentStream;
      const childSessionId = request.resumeSessionId ?? request.agentId;
      if (deps.childRunner.createChild && request.runtimeGeneration !== undefined) {
        const runtime = deps.childRunner.createChild(childConfig);
        const supervisor = new ChildRunSupervisor(
          runtime,
          childSessionId,
          request.runtimeGeneration,
        );
        const ownerToken = nanoid();
        const bound = request.bindLiveControl?.(supervisor, ownerToken);
        supervisor.setCloseIntake(() =>
          request.closeLiveControl?.(
            supervisor,
            bound && bound !== true ? (bound as ChildWriterLease) : undefined,
          ),
        );
        if (bound === false) {
          throw new Error(`child session ${childSessionId} already has a live transcript writer`);
        }
        return await supervisor.run(request.prompt, {
          signal: request.signal,
          onStream: wrapChildRuntimeStream(destination, request.agentId, request.onProgressEvent),
          sessionId: childSessionId,
          onAgentProgress: request.onAgentProgress,
        });
      }
      const result = await deps.childRunner.runChild(childConfig, request.prompt, {
        signal: request.signal,
        onStream: wrapChildRuntimeStream(destination, request.agentId, request.onProgressEvent),
        sessionId: childSessionId,
      });
      return result;
    },
  };
}
