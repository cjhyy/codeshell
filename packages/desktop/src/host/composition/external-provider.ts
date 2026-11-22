import {
  ClaudeCodeRuntime,
  runClaudeTextInference,
  CodexRuntime,
  type ClaudeRuntimeOptions,
  type CodexRuntimeOptions,
  type ExternalRuntimeTurnInput,
  type CodexRuntimeHooks,
  type NativeApprovalDecision,
} from "@cjhyy/code-shell-capability-coding/external-runtimes";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { PrivateHostPeer, type PrivatePort } from "../native-peer.js";
import { dlog } from "../../main/desktop-logger.js";

type Bridge = Pick<NonNullable<CodexRuntimeOptions["bridge"]>, "url" | "token" | "tokenEnvVar">;
type Hook = Exclude<keyof CodexRuntimeHooks, "onEvent">;
export type ProviderStart =
  | {
      kind: "codex";
      options: Omit<CodexRuntimeOptions, "bridge" | "log" | "client"> & {
        bridge?: Bridge;
        client?: Omit<NonNullable<CodexRuntimeOptions["client"]>, "log">;
      };
      hooks: Hook[];
      searchPath: string;
    }
  | {
      kind: "claude-code";
      options: Omit<ClaudeRuntimeOptions, "bridge" | "log" | "now"> & { bridge: Bridge };
      searchPath: string;
    };
export interface ProviderFrame {
  type: "event" | "notification";
  value: unknown;
  method?: string;
}
export interface ProviderIdentity {
  runtimeSessionId?: string;
  resolvedModel?: string;
}

/** Batches preserve provider order while Main is busy. A consumer that cannot drain the bounded queue loses the session. */
export function bindExternalProvider(port: PrivatePort, retired: () => void) {
  let runtime: CodexRuntime | ClaudeCodeRuntime | undefined;
  let generation = 0;
  let closed = false;
  let maintenance: ReturnType<typeof runClaudeTextInference> | undefined;
  const stop = new AbortController();
  let closing: Promise<void> | undefined;
  const queue: Array<{ frame: ProviderFrame; bytes: number }> = [];
  let queuedBytes = 0;
  let draining: Promise<void> | undefined;
  const identity = (): ProviderIdentity => ({
    runtimeSessionId: runtime?.runtimeSessionId,
    resolvedModel: runtime?.resolvedModel,
  });
  function close() {
    if (closing) return closing;
    closed = true;
    stop.abort();
    generation++;
    queue.length = 0;
    queuedBytes = 0;
    closing = Promise.resolve()
      .then(async () => {
        await Promise.allSettled([runtime?.close(), maintenance]);
      })
      .finally(() => {
        peer.close();
        retired();
      });
    return closing;
  }
  function drain(): Promise<void> {
    if (draining) return draining;
    draining = Promise.resolve()
      .then(async () => {
        while (!closed && queue.length) {
          const batch = queue.splice(0, 64);
          queuedBytes -= batch.reduce((n, item) => n + item.bytes, 0);
          await peer.call("frames", {
            generation,
            identity: identity(),
            frames: batch.map((x) => x.frame),
          });
        }
      })
      .finally(() => {
        draining = undefined;
      });
    return draining;
  }
  function emit(frame: ProviderFrame) {
    if (closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (queuedBytes + bytes > 16 * 1024 * 1024 || queue.length >= 16384) {
      void close().catch(() => {});
      return;
    }
    queue.push({ frame, bytes });
    queuedBytes += bytes;
    void drain()
      .catch(() => close())
      .catch(() => {});
  }
  async function prompt<R>(name: Hook, request: unknown) {
    // Native approval observes every preceding tool/turn event before rendering the question.
    await drain();
    if (closed) throw Error("External provider stopped");
    return peer.call<R>(name, request);
  }
  function configure(input: ProviderStart) {
    if (runtime || closed) throw Error("External provider is already configured");
    // Main supplies its post-login-shell PATH. Worker launch still applies the coding package's allowlist.

    const log = (event: string, data: Record<string, unknown>) =>
      dlog("external-runtime", event, data);
    const bridge = input.options.bridge && { ...input.options.bridge, close: async () => {} };
    if (input.kind === "codex") {
      const hooks: CodexRuntimeHooks = { onEvent: (value) => emit({ type: "event", value }) };
      if (input.hooks.includes("onNativeApproval"))
        hooks.onNativeApproval = (req) => prompt<NativeApprovalDecision>("onNativeApproval", req);
      if (input.hooks.includes("onHostMcpApproval"))
        hooks.onHostMcpApproval = (req) => prompt<boolean>("onHostMcpApproval", req);
      if (input.hooks.includes("onForeignMcpApproval"))
        hooks.onForeignMcpApproval = (req) => prompt<boolean>("onForeignMcpApproval", req);
      if (input.hooks.includes("onUserInput"))
        hooks.onUserInput = (req) => prompt("onUserInput", req);
      if (input.hooks.includes("onNotification"))
        hooks.onNotification = (method, value) => emit({ type: "notification", method, value });
      runtime = new CodexRuntime(
        {
          ...input.options,
          client: {
            ...input.options.client,
            env: input.options.client?.env ?? { ...process.env, PATH: input.searchPath },
          },
          bridge,
          log,
        },
        hooks,
      );
    } else {
      if (input.kind !== "claude-code" || !bridge) throw Error("Invalid external provider");
      runtime = new ClaudeCodeRuntime({
        ...input.options,
        searchPath: input.searchPath,
        bridge,
        log,
      });
    }
  }
  const peer: PrivateHostPeer = new PrivateHostPeer(
    port,
    async (method, payload, signal) => {
      if (method === "memory") {
        if (runtime || maintenance || closed)
          throw Error("External memory inference requires a fresh provider port");
        const { input, searchPath } = payload as {
          input: import("../../main/external-runtime-memory.js").ExternalMemoryTextRequest;
          searchPath: string;
        };
        maintenance = runClaudeTextInference({
          cwd: input.cwd,
          model: input.model,
          maxTokens: input.maxTokens,
          systemPrompt: input.systemPrompt,
          userMessage: input.userMessage,
          signal: AbortSignal.any([signal, stop.signal]),
          env: { ...process.env, PATH: searchPath },
        });
        return maintenance;
      }
      if (maintenance) throw Error("External memory has no provider controls");
      if (method === "configure") {
        configure(payload as ProviderStart);
        return;
      }
      const active = runtime;
      if (!active || closed) throw Error("External provider unavailable");
      switch (method) {
        case "start":
          if (!(active instanceof CodexRuntime)) throw Error("Claude starts at turn submission");
          await active.start();
          return identity();
        case "turn": {
          const { id, input } = payload as { id: number; input: ExternalRuntimeTurnInput };
          if (id !== generation + 1) throw Error("Stale external provider turn");
          generation = id;
          const turn = await active.send(input, (event) =>
            emit({ type: "event", value: event satisfies StreamEvent }),
          );
          const finish = async (error?: unknown) => {
            await drain();
            if (!closed)
              await peer.call("done", {
                id,
                identity: identity(),
                ...(error !== undefined && {
                  error: error instanceof Error ? error.message : String(error),
                }),
              });
          };
          void turn.done
            .then(
              () => finish(),
              (error) => finish(error),
            )
            .catch(() => close())
            .catch(() => {});
          return {
            ...identity(),
            ...("accepted" in turn
              ? { accepted: turn.accepted, turnId: "turnId" in turn ? turn.turnId : undefined }
              : {}),
          };
        }
        case "interrupt":
          await active.interrupt();
          return;
        case "releaseIdle":
          return active instanceof ClaudeCodeRuntime && active.releaseIdle(payload === true);
        case "close":
          await active.close();
          return;
        default:
          throw Error("Unknown external provider control");
      }
    },
    () => {
      void close().catch(() => {});
    },
  );
  return close;
}
