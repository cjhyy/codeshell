import { AsyncLocalStorage } from "node:async_hooks";
import type { CloudAccountManager, CloudAccountTransport } from "@cjhyy/code-shell-server/account";
import {
  AccountDeviceService,
  type AccountDeviceDependencies,
} from "../../main/account-device-service.js";
import { createAccountRemoteAuthorizer } from "../../main/account-device-passkey.js";
import type { PrivateHostPeer } from "../native-peer.js";

export type DeviceMethod =
  | "list"
  | "projects"
  | "connect"
  | "resume"
  | "send"
  | "stop"
  | "approve"
  | "close";
export type DeviceInput<M extends Exclude<DeviceMethod, "list">> = Parameters<
  AccountDeviceService[M]
>[1];
/** Long-lived target sockets, cached dispatch proofs, approval routing and submission receipts all share this Host incarnation. */
export class HostedAccountDevices {
  private readonly service: AccountDeviceService;
  private accountLease?: AbortSignal;
  private readonly scopes = new AsyncLocalStorage<{ flow: string; signal: AbortSignal }>();
  constructor(
    private readonly peer: () => PrivateHostPeer,
    private readonly account: CloudAccountManager,
    transport?: Pick<AccountDeviceDependencies, "fetch" | "socket"> & {
      request?: CloudAccountTransport;
    },
  ) {
    const ask = <T>(method: string, input?: unknown, extra?: AbortSignal) => {
      const scope = this.scopes.getStore();
      if (!scope) throw Error("电脑操作已结束。");
      return peer().call<T>(
        method,
        { flow: scope.flow, input },
        extra ? AbortSignal.any([scope.signal, extra]) : scope.signal,
      );
    };
    this.service = new AccountDeviceService({
      fetch: transport?.fetch,
      socket: transport?.socket,
      identity: () => {
        const current = account.status();
        return current.state === "signed-in" && current.origin && current.account
          ? { origin: current.origin, accountId: current.account.id }
          : undefined;
      },
      credential: (identity, signal) =>
        account.getCredential(identity.origin, identity.accountId, signal),
      sourceProof: (identity, signal) => ask("devices/sourceProof", identity, signal),
      relayOrigin: (identity, scope) => ask("devices/relayOrigin", { identity, scope }),
      authorizeTarget: (target) =>
        createAccountRemoteAuthorizer({
          request: transport?.request,
          openExternal: (url) =>
            ask(
              "devices/openPasskey",
              { url, hostId: target.hostId, environmentId: target.environmentId },
              target.signal,
            ),
        })(target),
    });
    this.service.setEventSink((owner, event) => peer().notify("devices/event", { owner, event }));
  }
  run(method: string, raw: unknown, signal: AbortSignal) {
    const req = raw as {
      owner: number;
      flow: string;
      op: DeviceMethod;
      input: unknown;
      generation: number;
    } | null;
    if (method === "devices/retire") return this.service.retireIdentity();
    if (
      !req ||
      !Number.isSafeInteger(req.owner) ||
      (req.owner < 1 && !(req.owner === 0 && req.op === "list"))
    )
      throw Error("Invalid device owner");
    if (method === "devices/release") return this.service.releaseOwner(req.owner);
    if (
      method !== "devices/request" ||
      typeof req.flow !== "string" ||
      req.generation !== this.account.nativeAuthority().generation
    )
      throw Error("电脑操作已结束。");
    signal.throwIfAborted();
    const identity = this.account.status();
    if (!identity.origin || !identity.account) throw Error("请先登录账号。");
    const lease = this.account.captureRootAccount(
      identity.origin,
      identity.account.id,
      () => !signal.aborted,
    );
    if (lease.signal !== this.accountLease) {
      this.accountLease = lease.signal;
      lease.signal.addEventListener("abort", () => this.service.retireIdentity(), { once: true });
    }
    const confirm = async () => {
      await this.peer().call("devices/confirm", { flow: req.flow }, signal);
      lease.current();
    };
    return this.scopes.run({ flow: req.flow, signal }, async () => {
      if (req.op === "list") return this.service.list(req.owner);
      if (req.op === "send") {
        try {
          await confirm();
          this.service.send(req.owner, req.input as DeviceInput<"send">);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "任务发送失败。",
            delivery:
              (error as { delivery?: string })?.delivery === "unknown" ? "unknown" : "not-sent",
          };
        }
      }
      if (!["projects", "connect", "resume", "stop", "approve", "close"].includes(req.op))
        throw Error("Unknown account device action");
      if (req.op === "stop" || req.op === "approve") await confirm();
      return this.service[req.op](req.owner, req.input as never);
    });
  }
  close() {
    this.service.retireIdentity();
  }
}
