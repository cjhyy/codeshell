/**
 * Bridge tests. These drive the REAL HTTP server over a real socket — the
 * transport details are exactly where the Phase 0-B probe found two failures
 * that both disguised themselves as "user cancelled MCP tool call", so mocking
 * the transport away would defeat the purpose.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  codexBridgeConfigArgs,
  startLoopbackMcpBridge,
  threadIdFromMeta,
  type BridgeToolHost,
  type McpBridgeHandle,
} from "./mcp-bridge.js";
import { SessionContextStore } from "./session-context-store.js";

const open: McpBridgeHandle[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

function fakeHost(sessionId: string, calls: string[]): BridgeToolHost {
  return {
    businessSessionId: sessionId,
    listTools: () => [
      { name: "Panel", description: "Panels.", inputSchema: { type: "object", properties: {} } },
    ],
    execute: async (call) => {
      calls.push(`${sessionId}:${call.name}:${JSON.stringify(call.input)}`);
      return { result: `ran ${call.name} in ${sessionId}` };
    },
  };
}

async function boot(calls: string[] = []) {
  const store = new SessionContextStore<BridgeToolHost>();
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const handle = await startLoopbackMcpBridge({
    store,
    log: (event, data) => logs.push({ event, data }),
  });
  open.push(handle);
  return { store, handle, logs, calls };
}

/** Speak the wire protocol the way Codex does: SSE-accepting, bearer auth. */
async function rpc(
  handle: McpBridgeHandle,
  body: unknown,
  opts: { token?: string | null; accept?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: opts.accept ?? "text/event-stream, application/json",
  };
  const token = opts.token === undefined ? handle.token : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(handle.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!text) return { status: response.status, json: undefined };
  // SSE frame → JSON payload.
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: response.status, json: JSON.parse((line ?? text).replace(/^data: /, "")) };
}

describe("Codex MCP bridge", () => {
  test("rejects a request with no or wrong bearer token", async () => {
    const { handle } = await boot();
    expect((await rpc(handle, { id: 1, method: "initialize" }, { token: null })).status).toBe(401);
    expect((await rpc(handle, { id: 1, method: "initialize" }, { token: "wrong" })).status).toBe(
      401,
    );
  });

  test("binds only to loopback", async () => {
    const { handle } = await boot();
    expect(handle.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("answers as SSE when the client accepts it", async () => {
    // A plain JSON body here made Codex report the call as user-cancelled.
    const { handle } = await boot();
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({ id: 1, method: "initialize", params: {} }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("event: message");
  });

  test("still answers plain JSON to a client that does not accept SSE", async () => {
    const { handle } = await boot();
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ id: 1, method: "initialize", params: {} }),
    });
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("routes a call to the host bound to that thread", async () => {
    const calls: string[] = [];
    const { handle, store } = await boot(calls);
    store.register("thread-a", fakeHost("sess-a", calls));
    store.register("thread-b", fakeHost("sess-b", calls));

    await rpc(handle, {
      id: 2,
      method: "tools/call",
      params: { name: "Panel", arguments: { action: "list" }, _meta: { threadId: "thread-a" } },
    });
    await rpc(handle, {
      id: 3,
      method: "tools/call",
      params: { name: "Panel", arguments: { action: "list" }, _meta: { threadId: "thread-b" } },
    });

    expect(calls).toEqual(['sess-a:Panel:{"action":"list"}', 'sess-b:Panel:{"action":"list"}']);
  });

  test("a thread id in ARGUMENTS cannot redirect the call", async () => {
    // §22.4: the model controls arguments and cannot touch `_meta`.
    const calls: string[] = [];
    const { handle, store } = await boot(calls);
    store.register("thread-a", fakeHost("sess-a", calls));
    store.register("thread-b", fakeHost("sess-b", calls));

    await rpc(handle, {
      id: 2,
      method: "tools/call",
      params: {
        name: "Panel",
        arguments: { action: "list", threadId: "thread-b", sessionId: "sess-b" },
        _meta: { threadId: "thread-a" },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("sess-a");
    expect(calls[0]).not.toContain("sess-b:");
  });

  test.each([
    ["missing thread id", {}, /no thread identity/i],
    ["unknown thread", { threadId: "thread-zzz" }, /not registered/i],
  ])("fails closed on %s", async (_label, meta, pattern) => {
    const calls: string[] = [];
    const { handle, store } = await boot(calls);
    store.register("thread-a", fakeHost("sess-a", calls));

    const { json } = await rpc(handle, {
      id: 2,
      method: "tools/call",
      params: { name: "Panel", arguments: {}, _meta: meta },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(pattern);
    // Nothing reached a host.
    expect(calls).toEqual([]);
  });

  test("a stale generation is refused after a restart", async () => {
    const calls: string[] = [];
    const { handle, store } = await boot(calls);
    store.register("thread-a", fakeHost("sess-old", calls));
    store.bumpGeneration();
    // The thread was NOT re-registered under the new generation.
    const { json } = await rpc(handle, {
      id: 2,
      method: "tools/call",
      params: { name: "Panel", arguments: {}, _meta: { threadId: "thread-a" } },
    });
    expect(json.result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("tools/list advertises nothing for an unroutable thread", async () => {
    // Guessing whose tools to show would leak one session's surface into
    // another session's prompt.
    const { handle, store } = await boot();
    store.register("thread-a", fakeHost("sess-a", []));
    const { json } = await rpc(handle, {
      id: 1,
      method: "tools/list",
      params: { _meta: { threadId: "thread-zzz" } },
    });
    expect(json.result.tools).toEqual([]);
  });

  test("tools/list returns the host's own tools when routable", async () => {
    const { handle, store } = await boot();
    store.register("thread-a", fakeHost("sess-a", []));
    const { json } = await rpc(handle, {
      id: 1,
      method: "tools/list",
      params: { _meta: { threadId: "thread-a" } },
    });
    expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual(["Panel"]);
  });

  test("an oversized body is refused", async () => {
    const store = new SessionContextStore<BridgeToolHost>();
    const handle = await startLoopbackMcpBridge({ store, maxBodyBytes: 256 });
    open.push(handle);
    const response = await fetch(handle.url, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: 1, method: "initialize", pad: "x".repeat(2000) }),
    });
    expect(response.status).toBe(413);
  });

  test("a batched (array) body is refused explicitly, not silently accepted", async () => {
    // An array body used to fall through every method branch and get
    // `200 {"result":{}}` — no host reached, so it failed closed, but it failed
    // SILENTLY and told the client it had succeeded.
    const calls: string[] = [];
    const { handle, store } = await boot(calls);
    store.register("thread-a", fakeHost("sess-a", calls));

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify([
        { id: 1, method: "tools/call", params: { name: "Panel", _meta: { threadId: "thread-a" } } },
      ]),
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as { error?: { message?: string } };
    expect(json.error?.message).toBeTruthy();
    expect(calls).toEqual([]);
  });

  test("a batch spanning two threads is refused as ambiguous", async () => {
    const calls: string[] = [];
    const { handle, store } = await boot(calls);
    store.register("thread-a", fakeHost("sess-a", calls));
    store.register("thread-b", fakeHost("sess-b", calls));

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify([
        { id: 1, method: "tools/call", params: { name: "Panel", _meta: { threadId: "thread-a" } } },
        { id: 2, method: "tools/call", params: { name: "Panel", _meta: { threadId: "thread-b" } } },
      ]),
    });
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("only POST is accepted", async () => {
    // A GET with a valid token used to answer 202. MCP Streamable HTTP reserves
    // GET for opening an SSE stream, which this bridge does not offer.
    const { handle } = await boot();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await fetch(handle.url, {
        method,
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(response.status).toBe(405);
    }
  });

  test("a reply always carries a JSON-RPC id", async () => {
    const { handle } = await boot();
    const { json } = await rpc(handle, { method: "initialize", params: {} });
    // No `id` in the request → `null`, never absent.
    expect("id" in json).toBe(true);
    expect(json.id).toBeNull();
  });

  describe("single-session pin (Claude Code, which sends no thread identity)", () => {
    async function bootPinned(calls: string[]) {
      const store = new SessionContextStore<BridgeToolHost>();
      const handle = await startLoopbackMcpBridge({
        store,
        singleSessionThreadId: "pinned",
      });
      open.push(handle);
      store.register("pinned", fakeHost("sess-pinned", calls));
      return { store, handle };
    }

    test("routes a call that carries no _meta at all", async () => {
      const calls: string[] = [];
      const { handle } = await bootPinned(calls);
      const { json } = await rpc(handle, {
        id: 1,
        method: "tools/call",
        params: { name: "Panel", arguments: { action: "list" } },
      });
      expect(json.result.isError).toBeFalsy();
      expect(calls).toEqual(['sess-pinned:Panel:{"action":"list"}']);
    });

    test("lists tools without a thread id", async () => {
      const { handle } = await bootPinned([]);
      const { json } = await rpc(handle, { id: 1, method: "tools/list", params: {} });
      expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual(["Panel"]);
    });

    test("the pin OVERRIDES a caller-supplied thread id", async () => {
      // The pin is the whole attribution. A runtime (or a model influencing one)
      // must not be able to steer routing by supplying a different `_meta`.
      const calls: string[] = [];
      const { store, handle } = await bootPinned(calls);
      store.register("someone-else", fakeHost("sess-other", calls));

      await rpc(handle, {
        id: 1,
        method: "tools/call",
        params: {
          name: "Panel",
          arguments: { action: "list" },
          _meta: { threadId: "someone-else" },
        },
      });
      // Landed in the pinned session, not the one the request named.
      expect(calls).toEqual(['sess-pinned:Panel:{"action":"list"}']);
    });

    test("an unpinned bridge still refuses a call with no thread id", async () => {
      // The pin must be opt-in. Without it the shared-bridge rules stand.
      const calls: string[] = [];
      const { handle, store } = await boot(calls);
      store.register("thread-a", fakeHost("sess-a", calls));
      const { json } = await rpc(handle, {
        id: 1,
        method: "tools/call",
        params: { name: "Panel", arguments: {} },
      });
      expect(json.result.isError).toBe(true);
      expect(calls).toEqual([]);
    });
  });

  test("malformed JSON is refused", async () => {
    const { handle } = await boot();
    const response = await fetch(handle.url, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  test("logs never contain the bearer token or full arguments", async () => {
    const calls: string[] = [];
    const { handle, store, logs } = await boot(calls);
    store.register("thread-a", fakeHost("sess-a", calls));
    await rpc(handle, {
      id: 2,
      method: "tools/call",
      params: {
        name: "Panel",
        arguments: { action: "list", secret: "SUPER-SECRET-VALUE" },
        _meta: { threadId: "thread-a" },
      },
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(handle.token);
    expect(serialized).not.toContain("SUPER-SECRET-VALUE");
    // …but it does carry the diagnosable fields §19 asks for.
    expect(serialized).toContain("toolName");
    expect(serialized).toContain("durationMs");
  });

  test("threadIdFromMeta reads both shapes Codex actually sends", () => {
    expect(threadIdFromMeta({ _meta: { threadId: "t1" } })).toBe("t1");
    expect(threadIdFromMeta({ _meta: { "x-codex-turn-metadata": { thread_id: "t2" } } })).toBe(
      "t2",
    );
    expect(threadIdFromMeta({ _meta: {} })).toBeUndefined();
    expect(threadIdFromMeta({})).toBeUndefined();
    expect(threadIdFromMeta(undefined)).toBeUndefined();
  });

  test("config args put the url on the command line and the token in the env", () => {
    const args = codexBridgeConfigArgs({
      url: "http://127.0.0.1:1/mcp",
      token: "SECRET",
      tokenEnvVar: "CODESHELL_CODEX_MCP_TOKEN",
      close: async () => {},
    });
    expect(args.join(" ")).toContain("http://127.0.0.1:1/mcp");
    expect(args.join(" ")).toContain("bearer_token_env_var");
    // The token itself must never be an argv value (§12.2).
    expect(args.join(" ")).not.toContain("SECRET");
  });
});
