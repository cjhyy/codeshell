import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { OutgoingAttachment } from "@cjhyy/code-shell-chat";
import { PrivateHostPeer, type PrivatePort } from "../../host/native-peer.js";
import type { ImNoticeOwner } from "../../host/im/private-notices.js";
import type { ImAction, ImOwnerView } from "../../host/im/gateway.js";
import type {
  GatewayControlServerOptions,
  GatewayControlEventInput,
  GatewayControlServer,
  OutboxDeliveryResult,
} from "../im-gateway-control-server.js";
import type {
  DingTalkSetup,
  DingTalkSetupInput,
  ImGatewayOwnerTarget,
  ImGatewayStatus,
  ImGatewayUiEvent,
} from "../im-gateway-service.js";
import {
  DINGTALK_CREDENTIAL_ID,
  dingTalkCredential,
  dingTalkCredentialSecret,
} from "../im-dingtalk-credential.js";
import { withDingTalkCredential } from "../im-dingtalk-custody.js";

type Effects = Pick<
  GatewayControlServerOptions,
  | "open"
  | "close"
  | "status"
  | "pairingUrl"
  | "petChat"
  | "routeSession"
  | "isPetChatReady"
  | "isSessionRouteReady"
> & {
  event(event: ImGatewayUiEvent): void;
  outcome(result: OutboxDeliveryResult): void;
  ready(): void;
};
type LiveOwner = { target: ImGatewayOwnerTarget; address: { channel: string; target: string } };
export class NativeImGateway {
  private peer?: PrivateHostPeer;
  private effects?: Effects;
  private booted = false;
  private bootstrapping?: Promise<void>;
  private runningPreference?: boolean;
  private scope = new AsyncLocalStorage<AbortSignal>();
  private scopes = new Map<
    string,
    {
      action: ImAction;
      signal: AbortSignal;
      inDocument: ReturnType<typeof AsyncLocalStorage.snapshot>;
      undo?: () => Promise<void>;
    }
  >();
  private lifetime = new AbortController();
  private view: ImOwnerView = { channels: [], targets: [] };
  constructor(private readonly waitForHost: (signal: AbortSignal) => Promise<void>) {}
  withDocument<T>(document: AbortSignal, work: () => T) {
    document.throwIfAborted();
    return this.scope.run(document, work);
  }
  bind(port: PrivatePort) {
    this.disconnect();
    const peer: PrivateHostPeer = new PrivateHostPeer(
      port,
      (method, data, signal) => this.handle(method, data, signal),
      () => {
        if (this.peer !== peer) return;
        this.peer = undefined;
        this.bootstrapping = undefined;
        this.lifetime.abort();
        this.lifetime = new AbortController();
        this.scopes.clear();
        this.view = { channels: [], targets: [] };
      },
      (method, data) => {
        if (this.peer !== peer) return;
        if (method === "im/event") this.effects?.event(data as ImGatewayUiEvent);
        if (method === "im/ownerView") this.view = data as ImOwnerView;
        if (method === "im/outcome") this.effects?.outcome(data as OutboxDeliveryResult);
        if (method === "im/ready") this.effects?.ready();
      },
    );
    this.peer = peer;
    if (this.booted) void this.startHost().catch(() => {});
  }
  disconnect() {
    this.peer?.close();
  }
  async boot(effects: Effects) {
    this.effects = effects;
    this.booted = true;
    await this.startHost();
  }
  private startHost() {
    if (!this.bootstrapping) {
      const flight = this.call<void>({ op: "boot", running: this.runningPreference });
      this.bootstrapping = flight;
      void flight.catch(() => {
        if (this.bootstrapping === flight) this.bootstrapping = undefined;
      });
    }
    return this.bootstrapping;
  }
  private async call<T>(action: ImAction): Promise<T> {
    const document = this.scope.getStore(),
      lifecycle = this.lifetime.signal;
    const signal = document ? AbortSignal.any([lifecycle, document]) : lifecycle;
    if (!this.peer) await this.waitForHost(signal);
    signal.throwIfAborted();
    if (!this.peer) throw Error("IM Host is unavailable");
    const flow = randomUUID();
    this.scopes.set(flow, { action, signal, inDocument: AsyncLocalStorage.snapshot() });
    try {
      const result = await this.peer.call<T>("im/request", { flow, action }, signal);
      signal.throwIfAborted();
      return result;
    } finally {
      this.scopes.delete(flow);
    }
  }
  private async handle(method: string, raw: unknown, signal: AbortSignal) {
    const req = raw as { flow?: string; input?: unknown };
    const scope = req.flow ? this.scopes.get(req.flow) : undefined;
    if (method === "im/restoreDingTalk") {
      if (scope?.action.op !== "saveDingTalkSetup") throw Error("钉钉配置授权已结束。");
      await scope.undo?.();
      scope.undo = undefined;
      return;
    }
    if (method === "im/confirmSetup") {
      if (scope?.action.op !== "saveDingTalkSetup") throw Error("钉钉配置授权已结束。");
      scope.signal.throwIfAborted();
      signal.throwIfAborted();
      return;
    }
    if (method === "im/readDingTalk") {
      if (
        !scope ||
        ![
          "boot",
          "status",
          "start",
          "getDingTalkSetup",
          "saveDingTalkSetup",
          "startDingTalkDiscovery",
          "send",
        ].includes(scope.action.op)
      )
        throw Error("钉钉凭据请求已结束。");
      const current = () => {
        signal.throwIfAborted();
        scope.signal.throwIfAborted();
      };
      const result = await withDingTalkCredential(
        false,
        (store) => dingTalkCredentialSecret(store.resolve(DINGTALK_CREDENTIAL_ID)),
        current,
      );
      current();
      return result;
    }
    if (method === "im/saveDingTalk") {
      const input = req.input as { clientId: string; secret: string };
      if (
        scope?.action.op !== "saveDingTalkSetup" ||
        typeof input?.secret !== "string" ||
        !input.secret ||
        input.secret.length > 65536 ||
        input.clientId !== scope.action.input.clientId.trim() ||
        (scope.action.input.clientSecret?.trim() &&
          input.secret !== scope.action.input.clientSecret.trim())
      )
        throw Error("钉钉配置授权已结束。");
      const current = () => {
        scope.signal.throwIfAborted();
        signal.throwIfAborted();
      };
      current();
      return scope.inDocument(() =>
        withDingTalkCredential(
          true,
          (store) => store.save("user", dingTalkCredential(input.clientId, input.secret)),
          current,
          async () => {
            current();
            if (!this.peer) throw Error("IM Host is unavailable");
            await this.peer.call("im/checkSetup", { flow: req.flow }, scope.signal);
          },
          (undo) => {
            scope.undo = undo;
          },
        ),
      );
    }
    const effects = this.effects;
    if (!effects) throw Error("IM control is not ready");
    signal.throwIfAborted();
    switch (method) {
      case "im/openTunnel":
        return effects.open();
      case "im/closeMobile":
        return effects.close();
      case "im/mobileStatus":
        return effects.status();
      case "im/pair":
        return effects.pairingUrl();
      case "im/petReady":
        return effects.isPetChatReady?.() ?? false;
      case "im/routesReady":
        return effects.isSessionRouteReady?.() ?? false;
      case "im/petChat":
        if (!(await effects.isPetChatReady?.()) || !effects.petChat) throw Error("Mimi 未就绪");
        return effects.petChat(req.input as Parameters<NonNullable<Effects["petChat"]>>[0]);
      case "im/routeSession":
        if (!(await effects.isSessionRouteReady?.()) || !effects.routeSession)
          throw Error("会话路由未就绪");
        return effects.routeSession(
          req.input as Parameters<NonNullable<Effects["routeSession"]>>[0],
        );
      default:
        throw Error("Unknown native IM effect");
    }
  }
  status() {
    return this.call<ImGatewayStatus>({ op: "status" });
  }
  async start() {
    const result = await this.call<ImGatewayStatus>({ op: "start" });
    this.runningPreference = result.running;
    return result;
  }
  async stop() {
    const result = await this.call<ImGatewayStatus>({ op: "stop" });
    this.runningPreference = result.running;
    return result;
  }
  ensureConfig() {
    return this.call<string>({ op: "ensureConfig" });
  }
  getDingTalkSetup() {
    return this.call<DingTalkSetup>({ op: "getDingTalkSetup" });
  }
  saveDingTalkSetup(input: DingTalkSetupInput) {
    return this.call<DingTalkSetup>({ op: "saveDingTalkSetup", input });
  }
  startDingTalkDiscovery() {
    return this.call<{ discoveryId: string }>({ op: "startDingTalkDiscovery" });
  }
  stopDingTalkDiscovery() {
    return this.call<boolean>({ op: "stopDingTalkDiscovery" });
  }
  async withWechatLogin<T>(work: () => Promise<T>) {
    const running = (await this.status()).running;
    const result = await work();
    await this.call({ op: "wechatRefreshed", restart: running });
    return result;
  }
  ownerChannels() {
    return this.view.channels;
  }
  listOwnerMessageTargets() {
    return this.view.targets;
  }
  lastOwnerInboundChannel() {
    return this.view.last;
  }
  isOwnerConversation(channel: string, target: string) {
    return this.call<boolean>({ op: "isOwner", channel, target }).catch(() => false);
  }
  liveOwnerChannel(channel: string) {
    return this.call<LiveOwner | undefined>({ op: "liveOwner", channel });
  }
  sendOwnerMessage(id: string, text: string, attachments: readonly OutgoingAttachment[] = []) {
    return this.call<ImGatewayOwnerTarget>({ op: "send", id, text, attachments });
  }
  publish(event: GatewayControlEventInput, owner?: ImNoticeOwner) {
    return this.call<void>({ op: "publish", event, owner });
  }
  revoke(deliveryKey: string) {
    return this.call<void>({ op: "revoke", key: deliveryKey });
  }
  deliveryState(deliveryKey: string) {
    return this.peer
      ? this.call<ReturnType<GatewayControlServer["deliveryState"]>>({
          op: "state",
          key: deliveryKey,
        }).catch(() => "not-ready" as const)
      : ("not-ready" as const);
  }
}
