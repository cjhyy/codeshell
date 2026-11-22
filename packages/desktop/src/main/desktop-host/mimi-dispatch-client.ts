import type {
  MimiGatewayInput,
  MimiGatewayNative,
  MimiGatewayResult,
} from "../../shared/mimi-gateway-turn.js";
import { randomUUID } from "node:crypto";
import { PrivateHostPeer, type PrivatePort } from "../../host/native-peer.js";
import type {
  DispatchConfiguration,
  MimiDispatchService,
  NativeMimiServices,
} from "../../shared/mimi-dispatch.js";
import type {
  PetDispatchCommand,
  PetPendingNoticeSource,
  PetHostActionExecutor,
} from "../pet/pet-dispatch-service.js";

const workerControls = new Set([
  "agent/run",
  "agent/steer",
  "agent/unsteer",
  "agent/cancel",
  "agent/goalGet",
]);
function reverseMethods(
  services: NativeMimiServices,
  notices: Map<string, PetPendingNoticeSource>,
  gates: Map<string, string>,
  gateway: Map<string, MimiGatewayNative>,
  peer: () => PrivateHostPeer,
) {
  const turn = (id: string) => {
    const bound = gateway.get(id);
    if (!bound) throw Error("Mimi gateway turn expired");
    return bound;
  };
  return {
    worker: (...args: Parameters<typeof services.worker.requestWorker>) => {
      if (!workerControls.has(args[0])) throw Error("Unknown Mimi worker operation");
      return services.worker.requestWorker(...args);
    },
    externalRun: (...args: Parameters<typeof services.externalRuntime.run>) =>
      services.externalRuntime.run(...args),
    externalStop: (...args: Parameters<typeof services.externalRuntime.stop>) =>
      services.externalRuntime.stop(...args),
    externalReset: (
      ...args: Parameters<NonNullable<typeof services.externalRuntime.resetContext>>
    ) => services.externalRuntime.resetContext?.(...args),
    clear: () => services.segmentController.requestContextClear?.(),
    begin: (...args: Parameters<typeof services.segmentController.beginTurn>) =>
      services.segmentController.beginTurn(...args),
    complete: (...args: Parameters<typeof services.segmentController.completeSegmentClosure>) =>
      services.segmentController.completeSegmentClosure(...args),
    closeDelegation: (...args: Parameters<typeof services.segmentController.onDelegationClosed>) =>
      services.segmentController.onDelegationClosed(...args),
    taskInbox: services.taskInbox,
    validateContinuation: services.validateFollowUpContinuation,
    recentProactive: services.recentProactive,
    owner: (...args: Parameters<typeof services.noticeTurns.isOwnerConversation>) =>
      services.noticeTurns.isOwnerConversation(...args),
    gateBegin: (sessionId: string, allowed: boolean, token: string) => {
      gates.set(sessionId, token);
      return services.noticeTurns.begin(
        sessionId,
        allowed,
        async () =>
          gates.get(sessionId) === token && (await peer().call<boolean>("gateCurrent", [token])),
      );
    },
    gateEnd: (sessionId: string, token: string) => {
      if (gates.get(sessionId) !== token) return;
      gates.delete(sessionId);
      return services.noticeTurns.end(sessionId);
    },
    action: (kind: string, ...args: Parameters<PetHostActionExecutor>) => {
      if (!Object.hasOwn(services.hostActions, kind)) throw Error("Unknown Mimi host action");
      return services.hostActions[kind]!(...args);
    },
    followUps: services.listFollowUps,
    targets: services.listOutboundTargets,
    roots: services.replyAttachmentRoots,
    workspaces: services.listWorkspaces,
    remoteContext: services.remoteContext,
    gatewaySubmitted: (id: string, event: Parameters<MimiGatewayNative["submitted"]>[0]) =>
      turn(id).submitted(event),
    gatewayDispatched: (id: string) => turn(id).dispatched(),
    gatewayAttachmentsSent: (id: string) => turn(id).attachmentsSent(),
    gatewayCompleted: (id: string, event: Parameters<MimiGatewayNative["completed"]>[0]) =>
      turn(id).completed(event),
    takePending: (id: string) => notices.get(id)?.take() ?? [],
    pendingStarted: (id: string) => notices.get(id)?.started(),
  };
}
type MimiPrivateCalls = MimiDispatchService & {
  gatewayTurn(input: MimiGatewayInput, token: string, replay: boolean): Promise<MimiGatewayResult>;
};
export type MimiNativeMethods = ReturnType<typeof reverseMethods>;
export class NativeMimiDispatch implements MimiDispatchService {
  private services?: NativeMimiServices;
  private peer?: PrivateHostPeer;
  private configured?: Promise<void>;
  private ready?: Promise<void>;
  private readonly notices = new Map<string, PetPendingNoticeSource>();
  private readonly gateway = new Map<string, MimiGatewayNative>();
  private readonly gates = new Map<string, string>();
  constructor(private readonly connect: () => Promise<void>) {}
  get needsPort() {
    return !!this.services && !this.peer;
  }
  configure(services: NativeMimiServices) {
    this.services = services;
    return this;
  }
  bind(port: PrivatePort) {
    const services = this.services;
    if (!services || this.peer) {
      port.close();
      return;
    }
    const methods = reverseMethods(services, this.notices, this.gates, this.gateway, () => peer);
    const peer: PrivateHostPeer = new PrivateHostPeer(
      port,
      (method, args, signal) => {
        signal.throwIfAborted();
        if (!Object.hasOwn(methods, method) || !Array.isArray(args))
          throw Error("Unknown native Mimi adapter");
        return Reflect.apply(methods[method as keyof MimiNativeMethods], undefined, args);
      },
      () => {
        if (this.peer === peer) this.disconnect();
      },
    );
    this.peer = peer;
    this.configured = peer.call("configure", [
      {
        hostCwd: services.hostCwd,
        actions: Object.keys(services.hostActions),
      } satisfies DispatchConfiguration,
    ]);
    void this.configured.catch(() => {});
  }
  disconnect() {
    const peer = this.peer;
    this.peer = undefined;
    this.configured = undefined;
    this.ready = undefined;
    peer?.close();
    for (const id of this.gates.keys()) this.services?.noticeTurns.end(id);
    this.gates.clear();
    this.notices.clear();
    this.gateway.clear();
  }
  private async invoke<K extends keyof MimiPrivateCalls>(
    method: K,
    args: unknown[],
    scope?: AbortSignal,
  ): Promise<Awaited<ReturnType<MimiPrivateCalls[K]>>> {
    scope?.throwIfAborted();
    if (!this.services) throw Error("Mimi dispatcher not configured");
    if (!this.peer)
      await (this.ready ??= this.connect().finally(() => {
        this.ready = undefined;
      }));
    const peer = this.peer;
    if (!peer) throw Error("Mimi Host unavailable");
    await this.configured;
    if (this.peer !== peer) throw Error("Mimi Host changed");
    const result = await peer.call<Awaited<ReturnType<MimiPrivateCalls[K]>>>(method, args, scope);
    scope?.throwIfAborted();
    return result;
  }
  async dispatch(command: PetDispatchCommand, signal?: AbortSignal) {
    if (command.type !== "chat" || !command.pendingNotices)
      return this.invoke("dispatch", [command], signal);
    const { pendingNotices, ...chat } = command;
    const token = randomUUID();
    this.notices.set(token, pendingNotices);
    try {
      return await this.invoke("dispatch", [{ ...chat, noticeSource: token }], signal);
    } finally {
      this.notices.delete(token);
    }
  }
  async gatewayTurn(
    input: MimiGatewayInput,
    callbacks: MimiGatewayNative,
    pending?: PetPendingNoticeSource,
  ) {
    const token = randomUUID();
    this.gateway.set(token, callbacks);
    if (pending) this.notices.set(token, pending);
    try {
      return await this.invoke("gatewayTurn", [input, token, !!pending]);
    } finally {
      this.gateway.delete(token);
      this.notices.delete(token);
    }
  }
  getSessionId() {
    return this.invoke("getSessionId", []);
  }
  wakeFollowUp(...args: Parameters<MimiDispatchService["wakeFollowUp"]>) {
    return this.invoke("wakeFollowUp", args);
  }
  reportSessionMessage(...args: Parameters<MimiDispatchService["reportSessionMessage"]>) {
    return this.invoke("reportSessionMessage", args);
  }
  reportLongTaskClosure(...args: Parameters<MimiDispatchService["reportLongTaskClosure"]>) {
    return this.invoke("reportLongTaskClosure", args);
  }
}
