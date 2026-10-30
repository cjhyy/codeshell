import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { MobileImageAttachment } from "@cjhyy/code-shell-core";
import type {
  AccountDeviceConnection,
  AccountDeviceEvent,
  AccountDeviceProject,
  AccountExecutionDevice,
} from "../shared/account-device.js";

export interface AccountDeviceIdentity {
  origin: string;
  accountId: string;
}
interface DeviceRecord extends AccountExecutionDevice {
  publicOrigin: string;
}
type Socket = Pick<WebSocket, "on" | "once" | "send" | "close" | "readyState">;
interface Connection extends AccountDeviceConnection {
  owner: number;
  identity: AccountDeviceIdentity;
  socket: Socket;
  alive: boolean;
  approvals: Map<string, { connectionId?: string; generation?: number; submitted?: boolean }>;
  submissions: Set<string>;
  expires: ReturnType<typeof setTimeout>;
  expiresAt: number;
}
export interface AccountDeviceDependencies {
  identity(): AccountDeviceIdentity | undefined;
  credential(identity: AccountDeviceIdentity, signal: AbortSignal): Promise<string>;
  sourceProof(
    identity: AccountDeviceIdentity,
    signal: AbortSignal,
  ): Promise<{ sourceHostId: string; sourceDeviceCredential: string }>;
  /** Must return the validated same-origin Account relay capability. */
  relayOrigin(identity: AccountDeviceIdentity): Promise<string>;
  fetch?: typeof fetch;
  socket?: (url: string, headers: Record<string, string>) => Socket;
}
const boundedId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const same = (a: AccountDeviceIdentity | undefined, b: AccountDeviceIdentity) =>
  a?.origin === b.origin && a.accountId === b.accountId;
function origin(value: unknown): string {
  if (typeof value !== "string") throw new Error("电脑目录地址无效。");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
    throw new Error("电脑目录需要可信 HTTPS 地址。");
  return value;
}

/** Adapter for the existing Host/mobile transport; it never executes tasks locally. */
export class AccountDeviceService {
  private epoch = 0;
  private operations = new Map<AbortController, number | undefined>();
  private connections = new Map<string, Connection>();
  private resumes = new Map<string, Promise<AccountDeviceConnection>>();
  private sink: (owner: number, event: AccountDeviceEvent) => void = () => {};
  constructor(private readonly deps: AccountDeviceDependencies) {}
  setEventSink(sink: (owner: number, event: AccountDeviceEvent) => void): void {
    this.sink = sink;
  }
  private async operation<T>(
    run: (ctx: {
      identity: AccountDeviceIdentity;
      directory: string;
      token: string;
      sourceProof: { sourceHostId: string; sourceDeviceCredential: string };
      signal: AbortSignal;
      assert(): void;
    }) => Promise<T>,
    owner?: number,
  ): Promise<T> {
    const identity = this.deps.identity();
    if (!identity) throw new Error("请先登录账号。");
    const revision = this.epoch;
    const controller = new AbortController();
    this.operations.set(controller, owner);
    const assert = () => {
      if (
        controller.signal.aborted ||
        revision !== this.epoch ||
        !same(this.deps.identity(), identity)
      )
        throw new Error("账号授权已结束。");
    };
    try {
      const directory = origin(await this.deps.relayOrigin(identity));
      if (directory !== origin(identity.origin))
        throw new Error("账号中继能力必须与账号服务同源。");
      assert();
      const token = await this.deps.credential(identity, controller.signal);
      assert();
      const sourceProof = await this.deps.sourceProof(identity, controller.signal);
      assert();
      if (!boundedId(sourceProof.sourceHostId) || !boundedId(sourceProof.sourceDeviceCredential))
        throw new Error("本机设备授权已失效。");
      return await run({
        identity,
        directory,
        token,
        sourceProof,
        signal: controller.signal,
        assert,
      });
    } finally {
      this.operations.delete(controller);
    }
  }
  private async json(
    url: string,
    signal: AbortSignal,
    headers: Record<string, string>,
    body?: unknown,
  ) {
    let response: Response;
    try {
      response = await (this.deps.fetch ?? fetch)(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { ...headers, Origin: new URL(url).origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("电脑连接失败，请检查在线状态后重新连接。操作不会自动重发。");
    }
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "电脑授权已失效，请重新连接。"
          : response.status === 409 || response.status === 503
            ? "电脑当前离线，无法派发任务。"
            : "电脑服务拒绝了请求，请检查服务版本。",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("电脑服务响应为空。");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new Error("电脑服务响应过大。");
      }
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(bytes);
    } catch {
      throw new Error("电脑服务响应无效。");
    }
  }
  private async directoryHosts(ctx: {
    directory: string;
    token: string;
    signal: AbortSignal;
  }): Promise<DeviceRecord[]> {
    const value = await this.json(`${ctx.directory}/api/v1/remote-hosts`, ctx.signal, {
      Authorization: `Bearer ${ctx.token}`,
    });
    if (!Array.isArray(value?.hosts)) throw new Error("服务尚不支持账号电脑目录，需要升级。");
    return value.hosts.map((device: any) => {
      if (
        !boundedId(device.hostId) ||
        !boundedId(device.environmentId) ||
        typeof device.name !== "string" ||
        typeof device.online !== "boolean" ||
        typeof device.revoked !== "boolean"
      )
        throw new Error("电脑目录响应无效。");
      return {
        hostId: device.hostId,
        environmentId: device.environmentId,
        name: device.name.slice(0, 160),
        online: device.online,
        revoked: device.revoked,
        protocolVersion: device.protocolVersion,
        publicOrigin: origin(device.publicOrigin),
        lastOnlineAt: device.lastOnlineAt,
      };
    });
  }
  async list(): Promise<AccountExecutionDevice[]> {
    return this.operation(async (ctx) => {
      const devices = await this.directoryHosts(ctx);
      ctx.assert();
      return devices.map(({ publicOrigin: _private, ...device }) => device);
    });
  }
  private async target(
    ctx: {
      directory: string;
      token: string;
      sourceProof: { sourceHostId: string; sourceDeviceCredential: string };
      signal: AbortSignal;
      assert(): void;
    },
    hostId: string,
  ) {
    if (!boundedId(hostId)) throw new Error("请选择执行电脑。");
    const target = (await this.directoryHosts(ctx)).find((item) => item.hostId === hostId);
    ctx.assert();
    if (!target || target.revoked) throw new Error("这台电脑未获该账号授权。");
    if (!target.online) throw new Error("电脑当前离线，无法派发任务。");
    const handoff = await this.json(
      `${ctx.directory}/api/v1/remote-hosts/${encodeURIComponent(hostId)}/handoffs`,
      ctx.signal,
      { Authorization: `Bearer ${ctx.token}` },
      { environmentId: target.environmentId, ...ctx.sourceProof },
    );
    ctx.assert();
    if (
      handoff?.hostId !== hostId ||
      handoff.environmentId !== target.environmentId ||
      handoff.publicOrigin !== target.publicOrigin ||
      !boundedId(handoff.handoff) ||
      !boundedId(handoff.relayAccessToken)
    )
      throw new Error("电脑授权交接与目标不匹配。");
    const relayHeaders = { "X-CodeShell-Relay-Access": handoff.relayAccessToken };
    const grant = await this.json(
      `${target.publicOrigin}/api/v1/relay/session`,
      ctx.signal,
      relayHeaders,
      { handoff: handoff.handoff },
    );
    ctx.assert();
    if (
      grant?.hostId !== hostId ||
      grant.environmentId !== target.environmentId ||
      !boundedId(grant.hostAccessToken) ||
      !boundedId(grant.deviceId) ||
      !boundedId(grant.secretHash) ||
      !Number.isFinite(grant.expiresAt) ||
      grant.expiresAt <= Date.now()
    )
      throw new Error("执行电脑返回的授权无效。");
    const headers = { ...relayHeaders, "X-CodeShell-Host-Access": grant.hostAccessToken };
    const listed = await this.json(
      `${target.publicOrigin}/api/v1/relay/projects`,
      ctx.signal,
      headers,
    );
    ctx.assert();
    if (
      listed?.hostId !== hostId ||
      listed.environmentId !== target.environmentId ||
      !Array.isArray(listed.projects)
    )
      throw new Error("电脑项目目录与目标不匹配。");
    const projects: AccountDeviceProject[] = listed.projects.map((project: any) => {
      if (
        !boundedId(project.id) ||
        typeof project.name !== "string" ||
        typeof project.path !== "string"
      )
        throw new Error("电脑项目目录无效。");
      return { id: project.id, name: project.name, path: project.path };
    });
    return { target, grant, headers, projects };
  }
  async projects(owner: number, input: { hostId: string }): Promise<AccountDeviceProject[]> {
    return this.operation(async (ctx) => (await this.target(ctx, input?.hostId)).projects, owner);
  }
  connect(
    owner: number,
    input: { hostId: string; projectId: string },
  ): Promise<AccountDeviceConnection> {
    return this.establish(owner, input);
  }
  async resume(owner: number, input: { connectionId: string }): Promise<AccountDeviceConnection> {
    const previous = this.connections.get(input?.connectionId);
    if (!previous || previous.owner !== owner || !same(this.deps.identity(), previous.identity))
      throw new Error("原电脑会话已失效或不属于当前窗口。");
    const existing = this.resumes.get(previous.id);
    if (existing) return existing;
    this.disconnect(previous);
    const pending = this.establish(
      owner,
      { hostId: previous.hostId, projectId: previous.projectId },
      previous,
    );
    this.resumes.set(previous.id, pending);
    try {
      return await pending;
    } finally {
      if (this.resumes.get(previous.id) === pending) this.resumes.delete(previous.id);
    }
  }
  private establish(
    owner: number,
    input: { hostId: string; projectId: string },
    previous?: Connection,
  ): Promise<AccountDeviceConnection> {
    return this.operation(async (ctx) => {
      if (!previous && this.connections.size >= 128)
        throw new Error("打开的电脑会话过多，请关闭暂不使用的会话后再连接。");
      const historyNeedsReview = !!previous;
      const assertCurrent = () => {
        ctx.assert();
        if (previous && this.connections.get(previous.id) !== previous)
          throw new Error("原电脑会话恢复已取消。");
      };
      const { target, grant, headers, projects } = await this.target(ctx, input?.hostId);
      assertCurrent();
      if (previous && target.environmentId !== previous.environmentId)
        throw new Error("电脑环境已更换，不能恢复原会话。");
      if (!projects.some((project) => project.id === input.projectId))
        throw new Error("请选择执行电脑的实际项目。");
      const url = new URL("/ws", target.publicOrigin);
      url.protocol = "wss:";
      const socketHeaders = { ...headers, Origin: target.publicOrigin };
      const socket =
        this.deps.socket?.(url.href, socketHeaders) ??
        new WebSocket(url, {
          headers: socketHeaders,
          followRedirects: false,
          maxPayload: 1_048_576,
        });
      const id = previous?.id ?? randomUUID();
      const requestId = randomUUID();
      let connection: Connection | undefined;
      let ended = false;
      let acknowledged = false;
      const buffered: any[] = [];
      let bufferedBytes = 0;
      const closePending = () => socket.close();
      ctx.signal.addEventListener("abort", closePending, { once: true });
      try {
        const sessionId = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            ended = true;
            socket.close();
            reject(new Error("电脑会话连接超时；没有发送任务。"));
          }, 15_000);
          const fail = () => {
            ended = true;
            clearTimeout(timer);
            reject(new Error("电脑已断线；没有自动重发任务。"));
          };
          socket.on("error", () => {
            fail();
            socket.close();
          });
          socket.on("close", () => {
            fail();
            if (connection?.socket === socket) this.disconnect(connection);
          });
          const writeHandshake = (event: unknown) => {
            try {
              assertCurrent();
              socket.send(JSON.stringify(event));
            } catch {
              fail();
              socket.close();
            }
          };
          socket.once("open", () =>
            writeHandshake({
              type: "auth.device",
              deviceId: grant.deviceId,
              secretHash: grant.secretHash,
            }),
          );
          let authenticated = false;
          socket.on("message", (bytes) => {
            if (ended) return;
            let event: any;
            try {
              event = JSON.parse(String(bytes));
            } catch {
              return;
            }
            if (event.type === "auth.failed") {
              fail();
              socket.close();
              return;
            }
            if (!connection) {
              if (acknowledged) {
                bufferedBytes += Buffer.byteLength(String(bytes), "utf8");
                if (buffered.length >= 64 || bufferedBytes > 1_048_576) {
                  fail();
                  socket.close();
                  return;
                }
                buffered.push(event);
                return;
              }
              if (event.type === "auth.ok" && !authenticated) {
                authenticated = true;
                writeHandshake(
                  previous
                    ? { type: "session.select", sessionId: previous.sessionId }
                    : {
                        type: "session.create",
                        projectId: input.projectId,
                        permissionMode: "default",
                        clientRequestId: requestId,
                      },
                );
              }
              const selected =
                previous &&
                authenticated &&
                event.type === "permission.mode" &&
                event.sessionId === previous.sessionId;
              const created =
                !previous &&
                authenticated &&
                event.type === "chat.accepted" &&
                event.clientRequestId === requestId &&
                boundedId(event.sessionId) &&
                event.projectId === input.projectId;
              if (selected || created) {
                acknowledged = true;
                clearTimeout(timer);
                resolve(previous?.sessionId ?? event.sessionId);
              }
              if (
                event.type === "error" &&
                (event.clientRequestId === requestId || (previous && !event.clientRequestId))
              ) {
                fail();
                socket.close();
              }
              return;
            }
            if (this.connections.get(id) === connection && connection.socket === socket)
              this.receive(connection, event);
          });
        });
        assertCurrent();
        if (ended || socket.readyState !== 1 || grant.expiresAt <= Date.now())
          throw new Error("电脑授权已到期，请恢复原会话；没有发送任务。");
        const expires = setTimeout(
          () => {
            if (connection) this.disconnect(connection);
          },
          Math.max(1, grant.expiresAt - Date.now()),
        );
        expires.unref?.();
        connection = {
          id,
          owner,
          identity: ctx.identity,
          hostId: target.hostId,
          environmentId: target.environmentId,
          projectId: input.projectId,
          sessionId,
          socket,
          alive: true,
          approvals: new Map(),
          submissions: previous?.submissions ?? new Set(),
          expires,
          expiresAt: grant.expiresAt,
          ...(historyNeedsReview ? { historyNeedsReview: true } : {}),
        };
        this.connections.set(id, connection);
        // Socket listeners must not retain a chain of every retired transport.
        previous = undefined;
        for (const event of buffered) this.receive(connection, event);
        buffered.length = 0;
        return {
          id,
          hostId: target.hostId,
          environmentId: target.environmentId,
          projectId: input.projectId,
          sessionId,
          ...(historyNeedsReview ? { historyNeedsReview: true } : {}),
        };
      } catch (error) {
        socket.close();
        throw error;
      } finally {
        ctx.signal.removeEventListener("abort", closePending);
      }
    }, owner);
  }
  /** Keep the original task binding recoverable; only explicit close/logout discards it. */
  private disconnect(connection: Connection): void {
    if (this.connections.get(connection.id) !== connection || !connection.alive) return;
    connection.alive = false;
    clearTimeout(connection.expires);
    connection.socket.close();
    this.emit(connection, "disconnected");
  }
  private emit(
    connection: Connection,
    type: "event" | "disconnected",
    event?: Record<string, any>,
  ) {
    this.sink(connection.owner, {
      connectionId: connection.id,
      hostId: connection.hostId,
      environmentId: connection.environmentId,
      projectId: connection.projectId,
      sessionId: connection.sessionId,
      type,
      ...(event ? { event } : {}),
    });
  }
  private receive(connection: Connection, event: any): void {
    if (!connection.alive || !same(this.deps.identity(), connection.identity)) return;
    const session = event.sessionId ?? event.params?.sessionId;
    // Device-specific admission failures carry the submission ID rather than a Session.
    const admissionError =
      event.type === "error" && connection.submissions.has(event.clientMessageId);
    const approvalError = event.type === "error" && connection.approvals.has(event.approvalId);
    if (session !== connection.sessionId && !admissionError && !approvalError) return;
    if (admissionError || event.type === "chat.accepted")
      connection.submissions.delete(event.clientMessageId);
    const payload = event.type === "session.stream" ? event.event : event;
    const approval =
      payload?.method === "agent/approvalRequest"
        ? payload.params
        : event.method === "agent/approvalRequest"
          ? event.params
          : undefined;
    if (approval?.requestId)
      connection.approvals.set(approval.requestId, {
        connectionId: approval.connectionId,
        generation: approval.generation,
      });
    const resolution =
      payload?.method === "agent/approvalResolved"
        ? payload.params
        : event.type === "approval.resolved"
          ? { ...event, requestId: event.approvalId }
          : undefined;
    if (resolution) {
      const pending = connection.approvals.get(resolution.requestId);
      if (
        pending &&
        pending.connectionId === resolution.connectionId &&
        pending.generation === resolution.generation
      )
        connection.approvals.delete(resolution.requestId);
    }
    this.emit(connection, "event", event);
  }
  private require(owner: number, id: string): Connection {
    const connection = this.connections.get(id);
    if (
      !connection ||
      connection.owner !== owner ||
      !connection.alive ||
      connection.expiresAt <= Date.now() ||
      connection.socket.readyState !== 1 ||
      !same(this.deps.identity(), connection.identity)
    )
      throw new Error("执行电脑已断线或授权已结束，请重新连接；任务不会转到本机。");
    return connection;
  }
  private write(connection: Connection, event: unknown): void {
    try {
      connection.socket.send(JSON.stringify(event));
    } catch {
      throw Object.assign(new Error("发送结果未知，请核对原电脑；操作不会自动重发。"), {
        delivery: "unknown",
      });
    }
  }
  send(
    owner: number,
    input: { connectionId: string; text: string; attachments?: MobileImageAttachment[] },
  ): void {
    try {
      const connection = this.require(owner, input?.connectionId);
      if (connection.submissions.size)
        throw new Error("上一任务的接收结果尚未确认，请先核对原电脑；不会自动重发。");
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 100_000)
        throw new Error("请输入有效任务。");
      if (
        input.attachments &&
        (!Array.isArray(input.attachments) ||
          input.attachments.length > 8 ||
          input.attachments.some(
            (file) =>
              file.transport !== "inline" ||
              !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(file.dataUrl) ||
              file.dataUrl.length > 8_000_000,
          ))
      )
        throw new Error("仅支持有界图片附件。");
      const clientMessageId = randomUUID();
      const frame = JSON.stringify({
        type: "chat.send",
        sessionId: connection.sessionId,
        clientMessageId,
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      });
      if (Buffer.byteLength(frame, "utf8") > 1_048_576)
        throw new Error("任务和图片合计超过 1 MiB，请缩小图片后发送。");
      connection.submissions.add(clientMessageId);
      try {
        connection.socket.send(frame);
      } catch {
        throw Object.assign(new Error("发送结果未知，请核对原电脑；操作不会自动重发。"), {
          delivery: "unknown",
        });
      }
    } catch (error) {
      if ((error as { delivery?: unknown })?.delivery === "unknown") throw error;
      throw Object.assign(new Error(error instanceof Error ? error.message : "任务没有发送。"), {
        delivery: "not-sent",
      });
    }
  }
  stop(owner: number, input: { connectionId: string }): void {
    const connection = this.require(owner, input?.connectionId);
    this.write(connection, { type: "run.stop", sessionId: connection.sessionId });
  }
  approve(
    owner: number,
    input: {
      connectionId: string;
      approvalId: string;
      workerConnectionId?: string;
      generation?: number;
      approved: boolean;
      answer?: string;
    },
  ): void {
    const connection = this.require(owner, input?.connectionId);
    const route = connection.approvals.get(input.approvalId);
    if (
      !route ||
      route.submitted ||
      route.connectionId !== input.workerConnectionId ||
      route.generation !== input.generation ||
      typeof input.approved !== "boolean" ||
      (input.answer !== undefined &&
        (typeof input.answer !== "string" || input.answer.length > 10_000))
    )
      throw new Error("审批已过期或不属于该电脑会话。");
    route.submitted = true;
    this.write(connection, {
      type: "approval.respond",
      sessionId: connection.sessionId,
      approvalId: input.approvalId,
      connectionId: route.connectionId,
      generation: route.generation,
      decision: input.approved ? "approve" : "reject",
      scope: "once",
      ...(input.answer === undefined ? {} : { answer: input.answer }),
    });
  }
  close(owner: number, input: { connectionId: string }): void {
    const connection = this.connections.get(input?.connectionId);
    if (!connection || connection.owner !== owner) return;
    this.connections.delete(connection.id);
    clearTimeout(connection.expires);
    connection.alive = false;
    connection.socket.close();
    this.emit(connection, "disconnected");
  }
  releaseOwner(owner: number): void {
    for (const [operation, operationOwner] of this.operations)
      if (operationOwner === owner) operation.abort();
    for (const connection of [...this.connections.values()])
      if (connection.owner === owner) this.close(owner, { connectionId: connection.id });
  }
  /** Identity retirement never sends Stop to local/LAN sessions or rewrites running task ownership. */
  retireIdentity(): void {
    this.epoch++;
    for (const operation of this.operations.keys()) operation.abort();
    for (const connection of [...this.connections.values()])
      this.close(connection.owner, { connectionId: connection.id });
  }
}
