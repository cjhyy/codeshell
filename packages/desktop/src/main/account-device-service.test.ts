import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AccountDeviceService, type AccountDeviceIdentity } from "./account-device-service.js";
import type { AccountDeviceEvent } from "../shared/account-device.js";

class FixtureSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  selectionReply = true;
  constructor(
    readonly hostId: string,
    readonly serial: number,
  ) {
    super();
    queueMicrotask(() => this.emit("open"));
  }
  send(bytes: string) {
    const event = JSON.parse(bytes);
    this.sent.push(event);
    if (event.type === "auth.device") queueMicrotask(() => this.message({ type: "auth.ok" }));
    if (event.type === "session.create")
      queueMicrotask(() =>
        this.message({
          type: "chat.accepted",
          projectId: event.projectId,
          sessionId: `${this.hostId}-session-${this.serial}`,
          clientRequestId: event.clientRequestId,
        }),
      );
    if (event.type === "session.select" && this.selectionReply)
      queueMicrotask(() => {
        this.message({ type: "permission.mode", sessionId: event.sessionId, mode: "default" });
        // Selection replays pending approvals immediately after its acknowledgment.
        this.message({
          method: "agent/approvalRequest",
          params: {
            sessionId: event.sessionId,
            requestId: "restored-approval",
            connectionId: "restored-worker",
            generation: 2,
            request: { toolName: "Write" },
          },
        });
      });
  }
  message(event: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.emit("close");
    }
  }
}
function fixture(options: { grantTtlMs?: number } = {}) {
  let identity: AccountDeviceIdentity | undefined = {
    origin: "https://account.fixture.invalid",
    accountId: "account-a",
  };
  const devices = ["a", "b"].map((id) => ({
    hostId: id,
    environmentId: `env-${id}`,
    name: `Computer ${id}`,
    online: true,
    revoked: false,
    protocolVersion: 1,
    publicOrigin: `https://${id}.computer.fixture.invalid`,
  }));
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const sockets: FixtureSocket[] = [];
  const events: Array<{ owner: number; event: AccountDeviceEvent }> = [];
  let foreignCapability = false;
  let foreignEnvironment = false;
  let grantTtlMs = options.grantTtlMs ?? 60_000;
  let selectionReply = true;
  const service = new AccountDeviceService({
    identity: () => identity,
    credential: async () => "account-bearer-do-not-forward",
    sourceProof: async () => ({
      sourceHostId: "source-host",
      sourceDeviceCredential: "source-device-secret",
    }),
    relayOrigin: async (account) =>
      foreignCapability ? "https://untrusted.fixture.invalid" : account.origin,
    fetch: (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const headers = init.headers as Record<string, string>;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, headers, body });
      expect(init.redirect).toBe("error");
      expect(headers.Origin).toBe(parsed.origin);
      if (parsed.origin === "https://account.fixture.invalid") {
        expect(headers.Authorization).toBe("Bearer account-bearer-do-not-forward");
        if (parsed.pathname === "/api/v1/remote-hosts") return Response.json({ hosts: devices });
        const host = devices.find(
          (device) => parsed.pathname === `/api/v1/remote-hosts/${device.hostId}/handoffs`,
        );
        if (host) {
          expect(body).toEqual({
            environmentId: host.environmentId,
            sourceHostId: "source-host",
            sourceDeviceCredential: "source-device-secret",
          });
          return Response.json({
            ...host,
            environmentId: foreignEnvironment ? "wrong" : host.environmentId,
            handoff: "handoff-once",
            relayAccessToken: "relay-grant",
            expiresAt: Date.now() + 30_000,
          });
        }
      }
      const host = devices.find((device) => device.publicOrigin === parsed.origin);
      if (!host) throw new Error(`Fixture blocked unexpected origin ${parsed.origin}`);
      expect(headers.Authorization).toBeUndefined();
      expect(JSON.stringify({ body, headers })).not.toContain("source-device-secret");
      expect(headers["X-CodeShell-Relay-Access"]).toBe("relay-grant");
      if (parsed.pathname === "/api/v1/relay/session") {
        expect(body).toEqual({ handoff: "handoff-once" });
        return Response.json({
          hostId: host.hostId,
          environmentId: host.environmentId,
          hostAccessToken: "host-grant",
          deviceId: `device-${sockets.length}`,
          secretHash: "device-secret",
          expiresAt: Date.now() + grantTtlMs,
        });
      }
      if (parsed.pathname === "/api/v1/relay/projects") {
        expect(headers["X-CodeShell-Host-Access"]).toBe("host-grant");
        return Response.json({
          hostId: host.hostId,
          environmentId: host.environmentId,
          projects: [
            { id: "shared-project-id", name: "Project", path: `/${host.hostId}/real-project` },
          ],
        });
      }
      throw new Error(`Fixture blocked unexpected path ${parsed.pathname}`);
    }) as typeof fetch,
    socket: (url, headers) => {
      const host = devices.find(
        (device) => new URL(url).origin === device.publicOrigin.replace("https:", "wss:"),
      );
      expect(host).toBeDefined();
      expect(headers.Authorization).toBeUndefined();
      expect(headers.Origin).toBe(host!.publicOrigin);
      const socket = new FixtureSocket(host!.hostId, sockets.length);
      socket.selectionReply = selectionReply;
      sockets.push(socket);
      return socket as any;
    },
  });
  service.setEventSink((owner, event) => events.push({ owner, event }));
  return {
    service,
    devices,
    sockets,
    requests,
    events,
    setGrantLifetime(value: number) {
      grantTtlMs = value;
    },
    withholdSelectionReply() {
      selectionReply = false;
    },
    switchIdentity() {
      identity = { origin: "https://account.fixture.invalid", accountId: "account-b" };
    },
    signOut() {
      identity = undefined;
      service.retireIdentity();
    },
    foreignCapability() {
      foreignCapability = true;
    },
    foreignEnvironment() {
      foreignEnvironment = true;
    },
  };
}

test("account devices bind tasks, output, approvals and Stop to the original Host/project/session", async () => {
  const f = fixture();
  try {
    expect(await f.service.list()).toHaveLength(2);
    const a = await f.service.connect(10, { hostId: "a", projectId: "shared-project-id" });
    const b = await f.service.connect(10, { hostId: "b", projectId: "shared-project-id" });
    expect(a.sessionId).not.toBe(b.sessionId);
    f.service.send(10, { connectionId: a.id, text: "Task on A" });
    f.service.send(10, { connectionId: b.id, text: "Task on B" });
    expect(f.sockets[0]!.sent.at(-1)).toMatchObject({
      type: "chat.send",
      sessionId: a.sessionId,
      text: "Task on A",
    });
    expect(f.sockets[1]!.sent.at(-1)).toMatchObject({ type: "chat.send", sessionId: b.sessionId });
    f.sockets[0]!.message({
      type: "session.stream",
      sessionId: b.sessionId,
      event: {
        method: "agent/streamEvent",
        params: { event: { type: "text_delta", text: "foreign" } },
      },
    });
    expect(f.events).toHaveLength(0);
    f.sockets[0]!.message({
      type: "session.stream",
      sessionId: a.sessionId,
      event: {
        method: "agent/streamEvent",
        params: { event: { type: "text_delta", text: "A output" } },
      },
    });
    expect(f.events[0]).toMatchObject({
      owner: 10,
      event: { hostId: "a", environmentId: "env-a", sessionId: a.sessionId, connectionId: a.id },
    });
    const approval = {
      method: "agent/approvalRequest",
      params: {
        sessionId: a.sessionId,
        requestId: "approval-a",
        connectionId: "worker-a",
        generation: 7,
        request: { toolName: "Write" },
      },
    };
    f.sockets[0]!.message(approval);
    expect(() =>
      f.service.approve(10, { connectionId: b.id, approvalId: "approval-a", approved: true }),
    ).toThrow("审批已过期");
    f.service.approve(10, {
      connectionId: a.id,
      approvalId: "approval-a",
      workerConnectionId: "worker-a",
      generation: 7,
      approved: false,
    });
    expect(f.sockets[0]!.sent.at(-1)).toMatchObject({
      type: "approval.respond",
      sessionId: a.sessionId,
      connectionId: "worker-a",
      generation: 7,
      decision: "reject",
    });
    f.service.stop(10, { connectionId: a.id });
    expect(f.sockets[0]!.sent.at(-1)).toEqual({ type: "run.stop", sessionId: a.sessionId });
    expect(() => f.service.stop(99, { connectionId: a.id })).toThrow("授权已结束");
    f.sockets[0]!.close();
    const before = f.sockets[0]!.sent.length;
    expect(() => f.service.send(10, { connectionId: a.id, text: "No fallback" })).toThrow(
      "不会转到本机",
    );
    expect(f.sockets[0]!.sent).toHaveLength(before);
    expect(f.events.at(-1)?.event).toMatchObject({ type: "disconnected", connectionId: a.id });
    const publicBytes = JSON.stringify({ a, b, events: f.events, devices: await f.service.list() });
    for (const secret of [
      "account-bearer",
      "relay-grant",
      "host-grant",
      "device-secret",
      "source-device-secret",
    ])
      expect(publicBytes).not.toContain(secret);
  } finally {
    f.service.retireIdentity();
  }
});

test("late approval answers and resolutions cannot target a reused request from another worker generation", async () => {
  const f = fixture();
  try {
    const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    const socket = f.sockets[0]!;
    const request = (generation: number) =>
      socket.message({
        method: "agent/approvalRequest",
        params: {
          sessionId: connection.sessionId,
          requestId: "reused-id",
          connectionId: "worker-a",
          generation,
          request: { toolName: "Write" },
        },
      });
    const resolve = (generation: number) =>
      socket.message({
        method: "agent/approvalResolved",
        params: {
          sessionId: connection.sessionId,
          requestId: "reused-id",
          connectionId: "worker-a",
          generation,
        },
      });
    request(1);
    request(2);
    resolve(1);
    const before = socket.sent.length;
    expect(() =>
      f.service.approve(1, {
        connectionId: connection.id,
        approvalId: "reused-id",
        workerConnectionId: "worker-a",
        generation: 1,
        approved: true,
      }),
    ).toThrow("审批已过期");
    expect(socket.sent).toHaveLength(before);
    f.service.approve(1, {
      connectionId: connection.id,
      approvalId: "reused-id",
      workerConnectionId: "worker-a",
      generation: 2,
      approved: false,
    });
    expect(socket.sent.at(-1)).toMatchObject({ generation: 2, decision: "reject" });
    request(3);
    resolve(3);
    expect(() =>
      f.service.approve(1, {
        connectionId: connection.id,
        approvalId: "reused-id",
        workerConnectionId: "worker-a",
        generation: 3,
        approved: true,
      }),
    ).toThrow("审批已过期");
  } finally {
    f.service.retireIdentity();
  }
});

test("offline, revoked, unknown project and foreign capability fail closed before task dispatch", async () => {
  const f = fixture();
  f.devices[0]!.online = false;
  await expect(
    f.service.connect(1, { hostId: "a", projectId: "shared-project-id" }),
  ).rejects.toThrow("离线");
  expect(f.requests).toHaveLength(1);
  f.devices[0]!.online = true;
  f.devices[0]!.revoked = true;
  await expect(
    f.service.connect(1, { hostId: "a", projectId: "shared-project-id" }),
  ).rejects.toThrow("未获");
  f.devices[0]!.revoked = false;
  await expect(f.service.connect(1, { hostId: "a", projectId: "/local/path" })).rejects.toThrow(
    "实际项目",
  );
  expect(f.sockets).toHaveLength(0);
  const before = f.requests.length;
  f.foreignCapability();
  await expect(f.service.list()).rejects.toThrow("同源");
  expect(f.requests).toHaveLength(before);
});

test("handoff target mismatch never forwards a handoff to a computer", async () => {
  const f = fixture();
  f.foreignEnvironment();
  await expect(
    f.service.connect(1, { hostId: "a", projectId: "shared-project-id" }),
  ).rejects.toThrow("目标不匹配");
  expect(
    f.requests.every(
      (request) => new URL(request.url).origin === "https://account.fixture.invalid",
    ),
  ).toBe(true);
});

test("identity change immediately denies old handles; logout closes streams without sending a local Stop", async () => {
  const f = fixture();
  const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
  f.switchIdentity();
  expect(() => f.service.send(1, { connectionId: connection.id, text: "other account" })).toThrow(
    "授权已结束",
  );
  f.signOut();
  expect(f.sockets[0]!.readyState).toBe(3);
  expect(f.sockets[0]!.sent.some((event) => event.type === "run.stop")).toBe(false);
  await expect(f.service.list()).rejects.toThrow("登录");
});

test("submission errors without sessionId are correlated; unknown admission and approval writes are never repeated", async () => {
  const f = fixture();
  try {
    const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    const socket = f.sockets[0]!;
    f.service.send(1, { connectionId: connection.id, text: "one intent" });
    const submission = socket.sent.at(-1);
    expect(() => f.service.send(1, { connectionId: connection.id, text: "blind retry" })).toThrow(
      "接收结果尚未确认",
    );
    socket.message({
      type: "error",
      clientMessageId: "another-client",
      message: "foreign failure",
    });
    expect(f.events).toHaveLength(0);
    socket.message({
      type: "error",
      clientMessageId: submission.clientMessageId,
      message: "Task admission rejected",
    });
    expect(f.events.at(-1)?.event.event).toMatchObject({
      type: "error",
      message: "Task admission rejected",
    });
    f.service.send(1, {
      connectionId: connection.id,
      text: "explicit new intent after known rejection",
    });
    expect(socket.sent.at(-1).clientMessageId).not.toBe(submission.clientMessageId);
    socket.message({
      method: "agent/approvalRequest",
      params: {
        sessionId: connection.sessionId,
        requestId: "one-approval",
        request: { toolName: "Write" },
      },
    });
    f.service.approve(1, {
      connectionId: connection.id,
      approvalId: "one-approval",
      approved: true,
    });
    const count = socket.sent.length;
    expect(() =>
      f.service.approve(1, {
        connectionId: connection.id,
        approvalId: "one-approval",
        approved: true,
      }),
    ).toThrow("审批已过期");
    expect(socket.sent).toHaveLength(count);
  } finally {
    f.service.retireIdentity();
  }
});

test("owner teardown aborts an in-flight handoff and cannot leave an orphan execution socket", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = new AccountDeviceService({
    identity: () => ({ origin: "https://account.fixture.invalid", accountId: "a" }),
    relayOrigin: async (identity) => identity.origin,
    sourceProof: async () => ({ sourceHostId: "source", sourceDeviceCredential: "source-secret" }),
    credential: async () => {
      started();
      await gate;
      return "never-forward";
    },
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  const pending = service.connect(12, { hostId: "a", projectId: "p" });
  await start;
  service.releaseOwner(12);
  release();
  await expect(pending).rejects.toThrow("授权已结束");
});

test("expiry restores the same task binding and buffered approvals without replaying an unknown submission", async () => {
  const f = fixture({ grantTtlMs: 30 });
  try {
    const original = await f.service.connect(10, { hostId: "a", projectId: "shared-project-id" });
    f.service.send(10, { connectionId: original.id, text: "long task" });
    const oldSocket = f.sockets[0]!;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.events.at(-1)?.event.type).toBe("disconnected");
    const beforeForeign = f.requests.length;
    await expect(f.service.resume(99, { connectionId: original.id })).rejects.toThrow("不属于");
    expect(f.requests).toHaveLength(beforeForeign);
    f.setGrantLifetime(60_000);
    const restored = await f.service.resume(10, { connectionId: original.id });
    expect(restored).toEqual({ ...original, historyNeedsReview: true });
    const socket = f.sockets[1]!;
    expect(socket.sent.map((event) => event.type)).toEqual(["auth.device", "session.select"]);
    expect(socket.sent[1]).toEqual({ type: "session.select", sessionId: original.sessionId });
    expect(
      f.sockets.flatMap((item) => item.sent).filter((event) => event.type === "chat.send"),
    ).toHaveLength(1);
    expect(f.events.at(-1)?.event.event?.method).toBe("agent/approvalRequest");
    const count = f.events.length;
    oldSocket.emit("close");
    oldSocket.message({
      type: "session.stream",
      sessionId: original.sessionId,
      event: { method: "late-old-stream" },
    });
    expect(f.events).toHaveLength(count);
    f.service.stop(10, { connectionId: restored.id });
    expect(socket.sent.at(-1)).toEqual({ type: "run.stop", sessionId: original.sessionId });
    f.service.approve(10, {
      connectionId: restored.id,
      approvalId: "restored-approval",
      workerConnectionId: "restored-worker",
      generation: 2,
      approved: false,
    });
    expect(socket.sent.at(-1)).toMatchObject({
      type: "approval.respond",
      sessionId: original.sessionId,
      generation: 2,
    });
    expect(() => f.service.send(10, { connectionId: restored.id, text: "blind resend" })).toThrow(
      "尚未确认",
    );
    expect(
      f.sockets.flatMap((item) => item.sent).filter((event) => event.type === "chat.send"),
    ).toHaveLength(1);
  } finally {
    f.service.retireIdentity();
  }
});

test("unexpected disconnect can resume, while explicit close and environment replacement cannot", async () => {
  const f = fixture();
  try {
    const original = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    f.sockets[0]!.close();
    const [first, second] = await Promise.all([
      f.service.resume(1, { connectionId: original.id }),
      f.service.resume(1, { connectionId: original.id }),
    ]);
    expect(first).toEqual(second);
    expect(first.sessionId).toBe(original.sessionId);
    expect(f.sockets).toHaveLength(2);
    f.sockets[1]!.close();
    f.devices[0]!.environmentId = "replaced-env";
    await expect(f.service.resume(1, { connectionId: original.id })).rejects.toThrow("环境已更换");
    expect(f.sockets).toHaveLength(2);
    f.service.close(1, { connectionId: original.id });
    await expect(f.service.resume(1, { connectionId: original.id })).rejects.toThrow(
      "原电脑会话已失效",
    );
  } finally {
    f.service.retireIdentity();
  }
});

test("resume cannot succeed before its exact session selection acknowledgment or survive owner teardown", async () => {
  const f = fixture();
  try {
    const original = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    f.withholdSelectionReply();
    let settled = false;
    const restoring = f.service.resume(1, { connectionId: original.id });
    void restoring.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const socket = f.sockets[1]!;
    socket.message({ type: "permission.mode", sessionId: "foreign-session", mode: "default" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    f.service.releaseOwner(1);
    await expect(restoring).rejects.toThrow("断线");
    expect(socket.readyState).toBe(3);
    expect(f.sockets.flatMap((item) => item.sent).some((event) => event.type === "chat.send")).toBe(
      false,
    );
  } finally {
    f.service.retireIdentity();
  }
});

test("oversized final frames fail before socket writes or admission tracking with delivery not-sent", async () => {
  const f = fixture();
  try {
    const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    const socket = f.sockets[0]!;
    const before = socket.sent.length;
    let failure: any;
    try {
      f.service.send(1, {
        connectionId: connection.id,
        text: "picture",
        attachments: [
          { transport: "inline", dataUrl: "data:image/png;base64," + "A".repeat(1_048_576) },
        ] as any,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.delivery).toBe("not-sent");
    expect(failure?.message).toContain("1 MiB");
    expect(socket.sent).toHaveLength(before);
    f.service.send(1, { connectionId: connection.id, text: "small explicit task" });
    expect(socket.sent.at(-1)).toMatchObject({ type: "chat.send", text: "small explicit task" });
    expect(Buffer.byteLength(JSON.stringify(socket.sent.at(-1)))).toBeLessThanOrEqual(1_048_576);
  } finally {
    f.service.retireIdentity();
  }
});

test("transport write failures retain unknown delivery and prevent a repeated task", async () => {
  const f = fixture();
  try {
    const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    const socket = f.sockets[0]!;
    socket.send = () => {
      throw new Error("synthetic transport write failure");
    };
    let failure: any;
    try {
      f.service.send(1, { connectionId: connection.id, text: "one task" });
    } catch (error) {
      failure = error;
    }
    expect(failure?.delivery).toBe("unknown");
    let repeated: any;
    try {
      f.service.send(1, { connectionId: connection.id, text: "blind retry" });
    } catch (error) {
      repeated = error;
    }
    expect(repeated?.delivery).toBe("not-sent");
    expect(repeated?.message).toContain("尚未确认");
  } finally {
    f.service.retireIdentity();
  }
});
