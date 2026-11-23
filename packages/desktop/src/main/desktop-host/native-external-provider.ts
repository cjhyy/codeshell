import { dlog } from "../desktop-logger.js";
import type {
  CodexRuntimeHooks,
  ExternalProviderFactories,
  ExternalRuntimeTurnInput,
} from "@cjhyy/code-shell-capability-coding/external-runtimes";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import type {
  ProviderStart,
  ProviderFrame,
  ProviderIdentity,
} from "../../host/composition/external-provider.js";
import { PrivateHostPeer, type PrivatePort } from "../../host/native-peer.js";

/** Retire every port on supervisor generation loss, including on transports that deliver close late. */
export class ExternalProviderPorts {
  private readonly active = new Set<() => void>();

  bind(port: PrivatePort): PrivatePort {
    let disconnected: (() => void) | undefined;
    const retire = () => {
      this.active.delete(retire);
      disconnected?.();
    };
    return {
      send: (message) => port.send(message),
      listen: (receive, closed) => {
        disconnected = closed;
        this.active.add(retire);
        port.listen(receive, retire);
      },
      close: () => {
        this.active.delete(retire);
        disconnected = undefined;
        port.close();
      },
    };
  }

  disconnect() {
    for (const retire of this.active) retire();
  }
}

function nativeProvider(port: PrivatePort, hooks: CodexRuntimeHooks, disconnected: () => void) {
  let closed = false;
  let retiring = false;
  let identity: ProviderIdentity = {};
  let seq = 0;
  let active:
    | {
        id: number;
        sink?: (event: StreamEvent) => void;
        deferred: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const peer = new PrivateHostPeer(
    port,
    (method, input) => {
      switch (method) {
        case "frames": {
          const {
            generation,
            frames,
            identity: next,
          } = input as { generation: number; frames: ProviderFrame[]; identity: ProviderIdentity };
          if (generation !== seq) return;
          identity = next;
          for (const f of frames) {
            try {
              if (f.type === "event") (active?.sink ?? hooks.onEvent)?.(f.value as StreamEvent);
              else if (f.type === "notification" && f.method)
                hooks.onNotification?.(f.method, f.value);
            } catch (error) {
              dlog("external-runtime", "runtime.event_handler_failed", { error: String(error) });
            }
          }
          return;
        }
        case "done": {
          const data = input as { id: number; identity: ProviderIdentity; error?: string };
          if (!active || active.id !== data.id) return;
          identity = data.identity;
          const { deferred } = active;
          active = undefined;
          if (data.error) deferred.reject(Error(data.error));
          else deferred.resolve();
          return;
        }
        case "onNativeApproval":
          return (
            hooks.onNativeApproval?.(
              input as Parameters<NonNullable<CodexRuntimeHooks["onNativeApproval"]>>[0],
            ) ?? "decline"
          );
        case "onHostMcpApproval":
          return (
            hooks.onHostMcpApproval?.(
              input as Parameters<NonNullable<CodexRuntimeHooks["onHostMcpApproval"]>>[0],
            ) ?? false
          );
        case "onForeignMcpApproval":
          return (
            hooks.onForeignMcpApproval?.(
              input as Parameters<NonNullable<CodexRuntimeHooks["onForeignMcpApproval"]>>[0],
            ) ?? false
          );
        case "onUserInput":
          if (!hooks.onUserInput) throw Error("External input unavailable");
          return hooks.onUserInput(
            input as Parameters<NonNullable<CodexRuntimeHooks["onUserInput"]>>[0],
          );
        default:
          throw Error("Unknown external provider adapter");
      }
    },
    () => {
      closed = true;
      active?.deferred.reject(Error("External provider disconnected"));
      active = undefined;
      if (!retiring) disconnected();
    },
  );
  return {
    async configure(input: ProviderStart) {
      try {
        await peer.call("configure", input);
      } catch (error) {
        peer.close();
        throw error;
      }
    },
    get runtimeSessionId() {
      return identity.runtimeSessionId;
    },
    get resolvedModel() {
      return identity.resolvedModel;
    },
    async start() {
      identity = await peer.call("start", null);
    },
    async send(input: ExternalRuntimeTurnInput, sink?: (event: StreamEvent) => void) {
      if (active) throw Error("An external provider turn is already running");
      const id = ++seq;
      const deferred = Promise.withResolvers<void>();
      void deferred.promise.catch(() => {});
      active = { id, deferred, sink: sink ?? hooks.onEvent };
      try {
        const next = await peer.call<ProviderIdentity & { accepted?: true; turnId?: string }>(
          "turn",
          { id, input },
        );
        if (seq === id)
          identity = {
            runtimeSessionId: next.runtimeSessionId ?? identity.runtimeSessionId,
            resolvedModel: next.resolvedModel ?? identity.resolvedModel,
          };
        return { accepted: next.accepted, turnId: next.turnId, done: deferred.promise };
      } catch (error) {
        if (active?.id === id) active = undefined;
        throw error;
      }
    },
    interrupt: () => peer.call<void>("interrupt", null),
    releaseIdle: (sticky = false) => peer.call<boolean>("releaseIdle", sticky),
    async close() {
      retiring = true;
      if (closed) return;
      try {
        await peer.call("close", null);
      } finally {
        peer.close();
      }
    },
  };
}

export function externalProviderFactories(
  open: (signal?: AbortSignal) => PrivatePort | Promise<PrivatePort>,
): ExternalProviderFactories {
  return {
    async codex({ bridge, client, log: _log, ...options }, hooks, disconnected) {
      const remote = nativeProvider(await open(), hooks, disconnected);
      const { log: _clientLog, ...launch } = client ?? {};
      await remote.configure({
        kind: "codex",
        options: {
          ...options,
          ...(bridge && {
            bridge: { url: bridge.url, tokenEnvVar: bridge.tokenEnvVar, token: bridge.token },
          }),
          client: launch,
        },
        hooks: (
          [
            "onNativeApproval",
            "onHostMcpApproval",
            "onForeignMcpApproval",
            "onUserInput",
            "onNotification",
          ] as const
        ).filter((k) => !!hooks[k]),
        searchPath: process.env.PATH ?? "",
      });
      return {
        get runtimeSessionId() {
          return remote.runtimeSessionId;
        },
        get resolvedModel() {
          return remote.resolvedModel;
        },
        start: remote.start,
        interrupt: remote.interrupt,
        close: remote.close,
        async send(input, sink) {
          const turn = await remote.send(input, sink);
          if (!turn.accepted) throw Error("Codex did not acknowledge the turn");
          return { ...turn, accepted: true };
        },
      };
    },
    async claude({ bridge, log: _log, now: _now, ...options }, hooks, disconnected) {
      const remote = nativeProvider(await open(), { onEvent: hooks.onEvent }, disconnected);
      await remote.configure({
        kind: "claude-code",
        options: {
          ...options,
          bridge: { url: bridge.url, tokenEnvVar: bridge.tokenEnvVar, token: bridge.token },
        },
        searchPath: process.env.PATH ?? "",
      });
      return remote;
    },
  };
}

/** Memory inference has no foreground session, MCP bridge or tool capabilities. */
export function inferExternalMemory(
  open: (signal?: AbortSignal) => PrivatePort | Promise<PrivatePort>,
) {
  return async ({
    signal,
    ...input
  }: import("../external-runtime-memory.js").ExternalMemoryTextRequest) => {
    signal?.throwIfAborted();
    const peer = new PrivateHostPeer(await open(signal), () => {
      throw Error("External memory has no native tool adapter");
    });
    try {
      return await peer.call<
        Awaited<
          ReturnType<
            typeof import("@cjhyy/code-shell-capability-coding/external-runtimes").runClaudeTextInference
          >
        >
      >("memory", { input, searchPath: process.env.PATH ?? "" }, signal);
    } finally {
      peer.close();
    }
  };
}
