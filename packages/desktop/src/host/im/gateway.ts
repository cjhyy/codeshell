import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { dlog } from "../../main/desktop-logger.js";
import { userHome } from "@cjhyy/code-shell-core";
import type { OutgoingAttachment } from "@cjhyy/code-shell-chat";
import { PrivateImNotices, type ImNoticeOwner } from "./private-notices.js";
import { PrivateHostPeer, type PrivatePort } from "../native-peer.js";
import {
  GatewayControlServer,
  type GatewayControlEventInput,
  type GatewayControlEvent,
  type GatewayControlServerOptions,
} from "../../main/im-gateway-control-server.js";
import {
  ImGatewayService,
  type ImGatewayServiceOptions,
  type DingTalkSetupInput,
  type ImGatewayOwnerChannel,
  type ImGatewayOwnerTarget,
} from "../../main/im-gateway-service.js";
import { dingTalkCredential, DINGTALK_CREDENTIAL_ID } from "../../main/im-dingtalk-credential.js";

export type ImOwnerView = {
  channels: ImGatewayOwnerChannel[];
  targets: ImGatewayOwnerTarget[];
  last?: string;
};
export type ImAction =
  | {
      op:
        | "status"
        | "start"
        | "stop"
        | "ensureConfig"
        | "getDingTalkSetup"
        | "startDingTalkDiscovery"
        | "stopDingTalkDiscovery";
    }
  | { op: "boot"; running?: boolean }
  | { op: "wechatRefreshed"; restart: boolean }
  | { op: "saveDingTalkSetup"; input: DingTalkSetupInput }
  | { op: "isOwner"; channel: string; target: string }
  | { op: "liveOwner"; channel: string }
  | { op: "publish"; event: GatewayControlEventInput; owner?: ImNoticeOwner }
  | { op: "send"; id: string; text: string; attachments: readonly OutgoingAttachment[] }
  | { op: "revoke" | "state"; key: string };

export function bindImGateway(
  port: PrivatePort,
  options: {
    descriptorPath?: string;
    gateway?: Pick<
      ImGatewayServiceOptions,
      "configPath" | "createChannelAdapter" | "createDingTalkAdapter"
    >;
  } = {},
) {
  const flows = new AsyncLocalStorage<string>();
  let secret: string | undefined;
  const pendingSetup = new Map<string, () => void>();
  let server: GatewayControlServer | undefined;
  let closing: Promise<void> | undefined;
  let writeTail: Promise<unknown> = Promise.resolve();
  let lifecycle: Promise<unknown> = Promise.resolve();
  const lifetime = new AbortController();
  const native = <T>(method: string, input?: unknown) =>
    peer.call<T>("im/" + method, { flow: flows.getStore(), input }, lifetime.signal);
  const gate = new ImGatewayService({
    ...options.gateway,
    ensureDesktopControl: async () => {
      await control().start();
    },
    credentialStore: {
      resolve: (id) =>
        id === DINGTALK_CREDENTIAL_ID && secret ? dingTalkCredential("", secret) : undefined,
      save: () => {
        throw Error("IM credential writes require the native keyring");
      },
    },
    emit: (event) => {
      peer.notify("im/event", event);
      if (event.type === "status-changed") publishView();
    },
  });
  const view = (): ImOwnerView => ({
    channels: gate.ownerChannels(),
    targets: gate.listOwnerMessageTargets(),
    last: gate.lastOwnerInboundChannel(),
  });
  const publishView = () => peer.notify("im/ownerView", view());
  function liveOwner(channel: string) {
    const selected = gate.ownerChannels().find((entry) => entry.id === channel);
    const target = gate.listOwnerMessageTargets().find((entry) => entry.id === selected?.targetId);
    const address = target && gate.resolveOwnerTarget(target.id);
    return address && target ? { target, address } : undefined;
  }
  const descriptorPath =
    options.descriptorPath ?? join(userHome(), ".code-shell", "im-gateway", "desktop-control.json");
  const privateNotices = new PrivateImNotices(
    join(dirname(descriptorPath), "private-notices.json"),
    (id, address) => {
      const current = liveOwner(address.channel);
      return (
        current?.target.id === id &&
        current.target.isDirect === true &&
        current.address.target === address.target
      );
    },
    (key) => server?.deliveryState(key) === "pending",
  );
  function control() {
    if (server) return server;
    const effects: GatewayControlServerOptions = {
      descriptorPath,
      projectEvent: (event) => privateNotices.project(event),
      legacyDesktopGatewayLockPath: gate.configuredGatewayLockPath(),
      open: () => native("openTunnel"),
      close: () => native("closeMobile"),
      status: () => native("mobileStatus"),
      pairingUrl: () => native("pair"),
      petChat: (value) => native("petChat", value),
      routeSession: (value) => native("routeSession", value),
      isPetChatReady: () => native("petReady"),
      isSessionRouteReady: () => native("routesReady"),
    };
    server = new GatewayControlServer(effects);
    server.onEventResult((result) => {
      peer.notify("im/outcome", result);
      privateNotices.settled(result.deliveryKey);
    });
    server.onEventAppended(handoff);
    return server;
  }
  function handoff(stored: GatewayControlEvent) {
    const server = control(),
      context = server.eventContext();
    const event = server.eventForDelivery(stored);
    if (!context || !event) return;
    const submit = (
      details: Omit<
        Parameters<GatewayControlServer["reportEventResult"]>[0],
        "streamId" | "eventId"
      >,
    ) => server.reportEventResult({ streamId: context.streamId, eventId: event.id, ...details });
    void gate
      .deliverPublishedNotification(event, {
        ...context,
        isLive: async () => server.isEventLive(context.streamId, event.id),
      })
      .then((result) => result && submit({ outcome: result.outcome }))
      .catch(async (error: unknown) => {
        dlog("main", "im_gateway.notification_direct.failed", {
          eventId: event.id,
          type: event.type,
          error: error instanceof Error ? error.name : "delivery-failed",
        });
        const failed = error as { attempted?: unknown; idempotent?: unknown };
        if (typeof failed?.attempted === "boolean")
          await submit({
            outcome: "failed",
            attempted: failed.attempted,
            idempotent: failed.idempotent === true,
            error: String(error).slice(0, 500),
          }).catch(() => {});
      });
  }
  async function prepareCredential(force = false) {
    if (force || (!process.env.CODE_SHELL_DINGTALK_CLIENT_SECRET && gate.usesDingTalkSetup())) {
      try {
        secret = await native<string | undefined>("readDingTalk");
      } catch (error) {
        secret = undefined;
        throw error;
      }
    } else {
      secret = undefined;
    }
  }
  async function run(action: ImAction, signal: AbortSignal) {
    signal.throwIfAborted();
    switch (action.op) {
      case "boot":
        await control().start();
        try {
          privateNotices.recover();
        } catch {
          dlog("main", "im_gateway.private_notices.unavailable");
        }
        peer.notify("im/ready", undefined);
        await prepareCredential();
        signal.throwIfAborted();
        if (action.running !== false) await gate.startConfiguredAtLaunch();
        publishView();
        return;
      case "status":
        await prepareCredential();
        return gate.status();
      case "start":
        await prepareCredential();
        signal.throwIfAborted();
        return gate.start();
      case "stop":
        return gate.stop();
      case "ensureConfig":
        return gate.ensureConfig();
      case "getDingTalkSetup":
        await prepareCredential(true);
        return gate.getDingTalkSetup();
      case "saveDingTalkSetup": {
        const operation = writeTail.then(async () => {
          await prepareCredential(true);
          signal.throwIfAborted();
          const plan = gate.prepareDingTalkSetup(action.input);
          const previous = secret;
          if (plan.secret) {
            const flow = flows.getStore()!;
            pendingSetup.set(flow, () => {
              signal.throwIfAborted();
              plan.assertUnchanged();
            });
            try {
              await native("saveDingTalk", { clientId: plan.clientId, secret: plan.secret });
              secret = plan.secret;
            } finally {
              pendingSetup.delete(flow);
            }
          } else {
            await native("confirmSetup");
          }
          try {
            signal.throwIfAborted();
            return plan.commit(() => signal.throwIfAborted());
          } catch (error) {
            if (plan.secret) {
              await native("restoreDingTalk");
              secret = previous;
            }
            throw error;
          }
        });
        writeTail = operation.catch(() => {});
        return operation;
      }
      case "startDingTalkDiscovery":
        await prepareCredential(true);
        signal.throwIfAborted();
        return gate.startDingTalkDiscovery();
      case "stopDingTalkDiscovery":
        return gate.stopDingTalkDiscovery();
      case "wechatRefreshed":
        return gate.afterWechatLogin(action.restart);
      case "isOwner":
        return gate.isOwnerConversation(action.channel, action.target);
      case "liveOwner":
        return liveOwner(action.channel);
      case "send":
        await prepareCredential();
        signal.throwIfAborted();
        return gate.sendOwnerMessage(action.id, action.text, action.attachments);
      case "publish": {
        const owner = action.owner;
        const guard = owner && {
          check() {
            signal.throwIfAborted();
            const address = action.event.target;
            const live = address && liveOwner(address.channel);
            if (
              !live ||
              live.target.id !== owner.targetId ||
              live.address.target !== address?.target ||
              (owner.nonDirectBody && live.target.isDirect !== true)
            )
              throw Error("IM 收件人权限已变更");
          },
          prepare: (event: GatewayControlEvent) => privateNotices.prepare(event, owner),
        };
        handoff(await control().publish(action.event, guard));
        return;
      }
      case "state":
        return server?.deliveryState(action.key) ?? (server ? undefined : "not-ready");
      case "revoke":
        return control().revokeDelivery(action.key, "notice-revoked");
      default:
        throw Error("Unknown IM operation");
    }
  }
  async function closeResources() {
    lifetime.abort();
    await gate.dispose();
    await server?.stop();
    secret = undefined;
  }
  const close = () => (closing ??= closeResources().finally(() => peer.close()));
  const peer: PrivateHostPeer = new PrivateHostPeer(
    port,
    (method, raw, signal) => {
      const input = raw as { flow: string; action: ImAction };
      if (method === "im/checkSetup" && !closing) {
        const current = pendingSetup.get(input?.flow);
        if (!current) throw Error("钉钉配置授权已结束。");
        return current();
      }
      if (closing || method !== "im/request" || !input?.action || typeof input.flow !== "string")
        throw Error("IM service unavailable");
      const work = () =>
        flows.run(input.flow, () => run(input.action, AbortSignal.any([signal, lifetime.signal])));
      if (["boot", "start", "stop", "wechatRefreshed"].includes(input.action.op)) {
        const next = lifecycle.then(work);
        lifecycle = next.catch(() => {});
        return next;
      }
      return work();
    },
    () => {
      void close().catch(() => {});
    },
  );
  return { close };
}
