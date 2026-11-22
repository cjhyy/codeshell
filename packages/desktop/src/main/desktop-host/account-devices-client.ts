import { deviceMessageContent } from "../../host/remote/device-message.js";
import { randomUUID } from "node:crypto";
import { isRelayToken } from "@cjhyy/code-shell-server/remote-relay";
import type {
  AccountDeviceConnection,
  AccountDeviceEvent,
  AccountDeviceProject,
  AccountExecutionDevice,
} from "../../shared/account-device.js";
import type { PrivateHostPeer } from "../../host/native-peer.js";
import type { DeviceInput, DeviceMethod } from "../../host/remote/account-devices.js";
import type { AccountDeviceDependencies } from "../account-device-service.js";
import type { NativeCloudAccount } from "./cloud-client.js";

type DeviceNative = Pick<AccountDeviceDependencies, "relayOrigin"> & {
  account: NativeCloudAccount;
  openExternal(url: string): Promise<void>;
};
type DeviceScope = {
  owner: number;
  op: DeviceMethod;
  origin: string;
  accountId: string;
  signal: AbortSignal;
  hostId?: string;
  environmentId?: string;
  current(): void;
};
export class NativeAccountDevices {
  private owners = new Map<number, AbortController>();
  private scopes = new Map<string, DeviceScope>();
  private connections = new Map<string, { owner: number; connection: AccountDeviceConnection }>();
  private sink: (id: number, event: AccountDeviceEvent) => void = () => {};
  constructor(
    private readonly peer: () => PrivateHostPeer,
    private readonly deps: DeviceNative,
  ) {}
  setEventSink(value: typeof this.sink) {
    this.sink = value;
  }
  notice(raw: unknown) {
    const req = raw as { owner: number; event: AccountDeviceEvent };
    if (req && this.owners.has(req.owner) && req.event) this.sink(req.owner, req.event);
  }
  disconnect() {
    for (const gate of this.owners.values()) gate.abort();
    for (const { owner, connection } of this.connections.values()) {
      try {
        this.sink(owner, { ...connection, connectionId: connection.id, type: "disconnected" });
      } catch {
        /* Window already closed. */
      }
    }
    this.owners.clear();
    this.scopes.clear();
    this.connections.clear();
  }
  releaseOwner(owner: number) {
    this.owners.get(owner)?.abort();
    this.owners.delete(owner);
    for (const [id, record] of this.connections)
      if (record.owner === owner) this.connections.delete(id);
    try {
      void this.peer()
        .call("devices/release", { owner })
        .catch(() => {});
    } catch {
      /* Host already stopped. */
    }
  }
  retireIdentity() {
    this.disconnect();
    try {
      void this.peer()
        .call("devices/retire", {})
        .catch(() => {});
    } catch {
      /* No old Host survives. */
    }
  }
  async handle(method: string, raw: unknown, signal: AbortSignal) {
    const req = raw as { flow: string; input: unknown } | null;
    const scope = req && this.scopes.get(req.flow);
    if (!scope || !req) throw Error("电脑操作已结束。");
    scope.current();
    signal.throwIfAborted();
    if (method === "devices/confirm" && ["send", "stop", "approve"].includes(scope.op)) return;
    if (method === "devices/openPasskey" && ["connect", "projects", "resume"].includes(scope.op)) {
      const target = req.input as { url: string; hostId: string; environmentId: string };
      if (
        !target ||
        !scope.hostId ||
        target.hostId !== scope.hostId ||
        (scope.environmentId && target.environmentId !== scope.environmentId) ||
        typeof target.url !== "string" ||
        target.url.length > 2048
      )
        throw Error("远程访问目标已变更。");
      const url = new URL(target.url);
      if (
        url.protocol !== "https:" ||
        url.origin !== scope.origin ||
        url.pathname !== "/remote-access" ||
        url.username ||
        url.password ||
        url.hash ||
        [...url.searchParams].length !== 1 ||
        !isRelayToken(url.searchParams.get("request"))
      )
        throw Error("远程访问验证地址无效。");
      return this.deps.openExternal(url.href);
    }
    const expected = { origin: scope.origin, accountId: scope.accountId };
    let result: unknown;
    if (
      method === "devices/relayOrigin" &&
      ["list", "projects", "connect", "resume"].includes(scope.op)
    ) {
      const args = req.input as { identity: typeof expected; scope: string };
      const need = scope.op === "list" ? "directory" : "dispatch";
      if (
        args?.identity?.origin !== scope.origin ||
        args.identity.accountId !== scope.accountId ||
        args.scope !== need
      )
        throw Error("设备账号已变更。");
      result = await this.deps.relayOrigin(expected, need);
    } else throw Error("Unknown account device callback");
    scope.current();
    signal.throwIfAborted();
    return result;
  }
  private async call<T>(op: DeviceMethod, owner: number, input?: unknown): Promise<T> {
    const authority = this.deps.account.deviceAuthority(),
      origin = authority.status.origin,
      accountId = authority.status.account?.id;
    if (!origin || !accountId) throw Error("请先登录账号。");
    const lease = this.deps.account.captureRootAccount(origin, accountId, () => true);
    const gate = this.owners.get(owner) ?? new AbortController();
    this.owners.set(owner, gate);
    const signal = AbortSignal.any([gate.signal, lease.signal]);
    const current = () => {
      signal.throwIfAborted();
      lease.current();
    };
    current();
    const peer = this.peer(),
      flow = randomUUID();
    const target = input as { hostId?: string; connectionId?: string } | undefined;
    const binding = target?.connectionId ? this.connections.get(target.connectionId) : undefined;
    if (["send", "stop", "approve", "resume"].includes(op) && binding?.owner !== owner)
      throw Error("连接已失效或不属于当前窗口。");
    this.scopes.set(flow, {
      op,
      owner,
      origin,
      accountId,
      signal,
      current,
      hostId: binding?.connection.hostId ?? target?.hostId,
      environmentId: binding?.connection.environmentId,
    });
    try {
      let result: T;
      try {
        result = await peer.call<T>(
          "devices/request",
          { flow, owner, op, input, generation: authority.generation },
          signal,
        );
        current();
      } catch (error) {
        if (op === "send")
          throw Object.assign(
            Error("发送结果未知，请核对原电脑；操作不会自动重发。", { cause: error }),
            { delivery: "unknown" },
          );
        throw error;
      }
      return result;
    } finally {
      this.scopes.delete(flow);
    }
  }
  list(owner = 0) {
    return this.call<AccountExecutionDevice[]>("list", owner);
  }
  projects(owner: number, input: DeviceInput<"projects">) {
    return this.call<AccountDeviceProject[]>("projects", owner, input);
  }
  private async establish(
    op: "connect" | "resume",
    owner: number,
    input: DeviceInput<"connect"> | DeviceInput<"resume">,
  ) {
    const connection = await this.call<AccountDeviceConnection>(op, owner, input);
    if ("connectionId" in input) this.connections.delete(input.connectionId);
    this.connections.set(connection.id, { owner, connection });
    return connection;
  }
  connect(owner: number, input: DeviceInput<"connect">) {
    return this.establish("connect", owner, input);
  }
  resume(owner: number, input: DeviceInput<"resume">) {
    return this.establish("resume", owner, input);
  }
  async send(owner: number, input: DeviceInput<"send">) {
    const value = await this.call<
      { ok: true } | { ok: false; error: string; delivery: "unknown" | "not-sent" }
    >("send", owner, { connectionId: input?.connectionId, ...deviceMessageContent(input) });
    if (!value.ok) throw Object.assign(Error(value.error), { delivery: value.delivery });
  }
  stop(owner: number, input: DeviceInput<"stop">) {
    return this.call<void>("stop", owner, input);
  }
  approve(owner: number, input: DeviceInput<"approve">) {
    return this.call<void>("approve", owner, input);
  }
  async close(owner: number, input: DeviceInput<"close">) {
    await this.call("close", owner, input);
    if (this.connections.get(input.connectionId)?.owner === owner)
      this.connections.delete(input.connectionId);
  }
}
