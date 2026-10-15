import { describe, expect, test } from "bun:test";
import { HostRuntime, type HostAdapter, type HostService } from "./runtime.js";
import { classifyHostRequest, interceptHostRequest, type HostRequest } from "./host-requests.js";

function adapter(overrides: Partial<HostAdapter> = {}): HostAdapter {
  return { kind: "headless", label: "fixture host", ...overrides };
}

function interceptFixture(services: HostService[] = []) {
  const runtime = new HostRuntime(adapter(), services);
  runtime.start();
  const responses: unknown[] = [];
  const approvals: Array<Record<string, unknown>> = [];
  return {
    runtime,
    responses,
    approvals,
    intercept(message: unknown) {
      return interceptHostRequest(message, JSON.stringify(message), {
        runtime,
        sendLine: (line) => responses.push(JSON.parse(line)),
        approve: (params) => approvals.push(params),
      });
    },
  };
}

function loopback(toolName: string, childHost?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: {
      sessionId: "session-1",
      requestId: "private-loopback-id",
      connectionId: "connection-1",
      generation: 9,
      request: { toolName, args: { action: "fixture" } },
      ...(childHost ? { childHost } : {}),
    },
  };
}

describe("HostRuntime capability registration", () => {
  test("rejects conflicts atomically and permits registration after a failed attempt", () => {
    const runtime = new HostRuntime(adapter(), [{ id: "browser", capabilities: ["browser"] }]);
    expect(() => runtime.register({ id: "browser", capabilities: ["panel"] })).toThrow(
      "Duplicate host service",
    );
    expect(() => runtime.register({ id: "conflict", capabilities: ["panel", "browser"] })).toThrow(
      "Duplicate host capability: browser",
    );
    expect(() => runtime.register({ id: "repeated", capabilities: ["panel", "panel"] })).toThrow(
      "Duplicate host capability: panel",
    );
    expect(() =>
      runtime.register({ id: "undeclared", capabilities: [], hostRequests: { panel: () => true } }),
    ).toThrow("Undeclared host capability: panel");
    expect(runtime.capabilities()).toEqual(["browser"]);
    runtime.register({ id: "panel", capabilities: ["panel"] });
    expect(runtime.capabilities()).toEqual(["browser", "panel"]);
    expect(runtime.supports("panel")).toBe(false);
    runtime.start();
    expect(runtime.supports("panel")).toBe(true);
    expect(() => runtime.register({ id: "late", capabilities: ["late"] })).toThrow("before start");
    runtime.stop();
    expect(runtime.supports("panel")).toBe(false);
    expect(() => runtime.start()).toThrow("stopped");
  });

  test("starts the adapter first and stops services in reverse order once", () => {
    const events: string[] = [];
    const hostAdapter = adapter({
      start: () => events.push("adapter:start"),
      stop: () => events.push("adapter:stop"),
    });
    const services = ["first", "second"].map((id) => ({
      id,
      capabilities: [id],
      start(received: HostAdapter) {
        expect(received).toBe(hostAdapter);
        events.push(`${id}:start`);
      },
      stop: () => events.push(`${id}:stop`),
    }));
    const runtime = new HostRuntime(hostAdapter, services);
    runtime.start();
    runtime.start();
    runtime.stop();
    runtime.stop();
    expect(events).toEqual([
      "adapter:start",
      "first:start",
      "second:start",
      "second:stop",
      "first:stop",
      "adapter:stop",
    ]);
  });

  test("rolls back partially started services and preserves startup plus cleanup failures", () => {
    const events: string[] = [];
    const startup = new Error("second startup failed");
    const cleanup = new Error("second cleanup failed");
    const adapterCleanup = new Error("adapter cleanup failed");
    const runtime = new HostRuntime(
      adapter({
        stop() {
          events.push("adapter:stop");
          throw adapterCleanup;
        },
      }),
      [
        { id: "first", capabilities: ["first"], stop: () => events.push("first:stop") },
        {
          id: "second",
          capabilities: ["second"],
          start() {
            throw startup;
          },
          stop() {
            events.push("second:stop");
            throw cleanup;
          },
        },
        { id: "third", capabilities: ["third"], stop: () => events.push("third:stop") },
      ],
    );
    let failure: unknown;
    try {
      runtime.start();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startup, cleanup, adapterCleanup]);
    expect((failure as AggregateError).cause).toBe(startup);
    expect(events).toEqual(["second:stop", "first:stop", "adapter:stop"]);
    expect(runtime.supports("first")).toBe(false);
    runtime.stop();
    expect(events).toHaveLength(3);
  });

  test("a failing adapter is rolled back and no services are started", () => {
    const startup = new Error("adapter failed");
    const events: string[] = [];
    const runtime = new HostRuntime(
      adapter({
        start() {
          throw startup;
        },
        stop: () => events.push("adapter:stop"),
      }),
      [{ id: "never", capabilities: [], start: () => events.push("never:start") }],
    );
    expect(() => runtime.start()).toThrow(startup);
    expect(events).toEqual(["adapter:stop"]);
  });

  test("startup rejects reentrant registration and rolls back", () => {
    const runtime = new HostRuntime(adapter());
    runtime.register({
      id: "first",
      capabilities: ["first"],
      start: () => runtime.register({ id: "late", capabilities: ["late"] }),
    });
    expect(() => runtime.start()).toThrow("before start");
    expect(runtime.capabilities()).toEqual(["first"]);
    expect(runtime.supports("first")).toBe(false);
  });
});

describe("HostRuntime production request interception", () => {
  test("dispatches an installed capability to its registered handler", () => {
    const calls: HostRequest[] = [];
    const f = interceptFixture([
      {
        id: "browser",
        capabilities: ["browser"],
        hostRequests: {
          browser(request) {
            calls.push(request);
            return true;
          },
        },
      },
    ]);
    const message = loopback("__browser_action__");
    expect(f.intercept(message)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "loopback", capability: "browser", message });
    expect(calls[0]?.line).toBe(JSON.stringify(message));
    expect(f.responses).toEqual([]);
    expect(f.approvals).toEqual([]);
    f.runtime.stop();
  });

  test("a supported downstream adapter route remains available", () => {
    const f = interceptFixture([{ id: "panel", capabilities: ["panel"] }]);
    expect(f.intercept(loopback("__panel_action__"))).toBe(false);
    expect(f.responses).toEqual([]);
    expect(f.approvals).toEqual([]);
    f.runtime.stop();
  });

  test("unsupported desktop requests get a private -32601 response with the Host label", () => {
    const f = interceptFixture();
    expect(
      f.intercept({ jsonrpc: "2.0", id: "worker-id", method: "desktop/automationCreate" }),
    ).toBe(true);
    expect(f.responses).toEqual([
      {
        jsonrpc: "2.0",
        id: "worker-id",
        error: {
          code: -32601,
          message: "desktop/automationCreate is not supported by this host (fixture host)",
          data: { failure: "unsupported", capability: "desktop/automationCreate" },
        },
      },
    ]);
    expect(f.approvals).toEqual([]);
    // Notifications have no request to settle and remain on the existing route.
    expect(f.intercept({ jsonrpc: "2.0", method: "desktop/operationBatch" })).toBe(false);
    expect(f.responses).toHaveLength(1);
    f.runtime.stop();
  });

  test.each([
    ["__browser_action__", "browser"],
    ["__credential_action__", "credential.browserCookie"],
    ["__workspace_action__", "workspace.switch"],
    ["__panel_action__", "panel"],
    ["__future_host_action__", "__future_host_action__"],
  ])(
    "unsupported %s resolves with a typed answer rather than a user denial",
    (toolName, capability) => {
      const f = interceptFixture();
      expect(f.intercept(loopback(toolName!))).toBe(true);
      expect(f.approvals).toHaveLength(1);
      expect(f.approvals[0]).toMatchObject({
        sessionId: "session-1",
        requestId: "private-loopback-id",
        connectionId: "connection-1",
        generation: 9,
        decision: { approved: true },
      });
      const decision = f.approvals[0]!.decision as { approved: boolean; answer: string };
      expect(JSON.parse(decision.answer)).toEqual({
        ok: false,
        failure: "unsupported",
        capability,
        error: `${capability} is not supported by this host (fixture host)`,
        detail: `${capability} is not supported by this host (fixture host)`,
      });
      expect(f.responses).toEqual([]);
      f.runtime.stop();
    },
  );

  test("AskUser, ordinary approvals, and unrelated messages retain their existing route", () => {
    const f = interceptFixture();
    for (const message of [
      loopback("__ask_user__"),
      loopback("Bash"),
      { jsonrpc: "2.0", method: "agent/streamEvent", params: { sessionId: "session-1" } },
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      null,
      [],
    ]) {
      expect(f.intercept(message)).toBe(false);
    }
    expect(f.responses).toEqual([]);
    expect(f.approvals).toEqual([]);
    f.runtime.stop();
  });

  test("child lifecycle frames are consumed without inventing an approval", () => {
    const f = interceptFixture();
    expect(f.intercept(loopback("__browser_action__", { activate: true }))).toBe(true);
    expect(f.intercept(loopback("__browser_action__", { release: true }))).toBe(true);
    expect(f.approvals).toEqual([]);
    expect(f.responses).toEqual([]);
    f.runtime.stop();
  });

  test("classification ignores malformed approval envelopes", () => {
    expect(
      classifyHostRequest({ method: "agent/approvalRequest", params: {} }, "fixture"),
    ).toBeUndefined();
    expect(
      classifyHostRequest(
        {
          method: "agent/approvalRequest",
          params: { sessionId: "s", requestId: 1, request: { toolName: "__browser_action__" } },
        },
        "fixture",
      ),
    ).toBeUndefined();
  });
});
