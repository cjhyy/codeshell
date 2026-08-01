/**
 * Runtime tests against a FAKE app-server, so CI needs no Codex binary or login.
 * The real-binary proof lives in `docs/todo/evidence/`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "./runtime.js";
import type { StreamEvent } from "@cjhyy/code-shell-core/extension";
import type { McpBridgeHandle } from "../shared/mcp-bridge.js";

const dirs: string[] = [];
const runtimes: CodexRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bridge: McpBridgeHandle = {
  url: "http://127.0.0.1:1/mcp",
  token: "T",
  tokenEnvVar: "CODESHELL_CODEX_MCP_TOKEN",
  close: async () => {},
};

function fakeServerScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-fake-appserver-"));
  dirs.push(dir);
  const file = join(dir, "server.mjs");
  writeFileSync(
    file,
    `import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let onLine = () => {};
const setOnLine = (fn) => { onLine = fn; };
createInterface({ input: process.stdin }).on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  onLine(m);
});
${body}
`,
  );
  return file;
}

/** A fake that completes a turn, streaming one text delta on the way. */
const HAPPY_PATH = `
let threadId = "thread-fake-1";
setOnLine((m) => {
  if (m.method === "initialize") return send({ id: m.id, result: { userAgent: "fake/1" } });
  if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: threadId } } });
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId, turn: { id: "turn-1" } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", itemId: "i1", delta: "hello" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
    return;
  }
  if (m.method === "turn/interrupt") return send({ id: m.id, result: {} });
});
`;

function makeRuntime(script: string, onEvent?: (event: StreamEvent) => void): CodexRuntime {
  const file = fakeServerScript(script);
  const runtime = new CodexRuntime(
    {
      cwd: process.cwd(),
      businessSessionId: "sess-runtime",
      bridge,
      client: { command: process.execPath, args: [file] },
    },
    onEvent ? { onEvent } : {},
  );
  runtimes.push(runtime);
  return runtime;
}

describe("CodexRuntime", () => {
  test("starts a thread and reports the runtime session id", async () => {
    const runtime = makeRuntime(HAPPY_PATH);
    await runtime.start();
    expect(runtime.runtimeSessionId).toBe("thread-fake-1");
    // The Codex thread id is protocol routing only — never the authorization
    // subject, which stays the CodeShell business session (§8.1).
    expect(runtime.runtimeSessionId).not.toBe("sess-runtime");
  });

  test("runs a turn and emits translated StreamEvents in order", async () => {
    const events: StreamEvent[] = [];
    const runtime = makeRuntime(HAPPY_PATH, (event) => events.push(event));
    await runtime.start();
    const turn = await runtime.send("hi");
    await turn.done;

    expect(events.map((event) => event.type)).toEqual([
      "stream_request_start",
      "text_delta",
      "turn_complete",
    ]);
    expect(events[1]).toEqual({ type: "text_delta", text: "hello" });
    expect(events[2]).toEqual({ type: "turn_complete", reason: "completed" });
  });

  test("turn.done resolves on completion, not on the RPC response", async () => {
    // The RPC only acknowledges acceptance; the turn ends on the notification.
    const runtime = makeRuntime(HAPPY_PATH);
    await runtime.start();
    const turn = await runtime.send("hi");
    await expect(turn.done).resolves.toBeUndefined();
    expect(turn.turnId).toBe("turn-1");
  });

  test("send() before start() is refused", async () => {
    const runtime = makeRuntime(HAPPY_PATH);
    await expect(runtime.send("hi")).rejects.toThrow(/before start/i);
  });

  test("a thread/start with no id fails loudly", async () => {
    const runtime = makeRuntime(`
      setOnLine((m) => {
        if (m.method === "initialize") return send({ id: m.id, result: {} });
        if (m.method === "thread/start") return send({ id: m.id, result: { thread: {} } });
      });
    `);
    await expect(runtime.start()).rejects.toThrow(/no thread id/i);
  });

  test("close() settles a turn that never completed", async () => {
    // §13.4: closing during a live turn must not leave the caller awaiting forever.
    const runtime = makeRuntime(`
      setOnLine((m) => {
        if (m.method === "initialize") return send({ id: m.id, result: {} });
        if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: "t" } } });
        if (m.method === "turn/start") return send({ id: m.id, result: { turn: { id: "turn-x" } } });
      });
    `);
    await runtime.start();
    const turn = await runtime.send("hi");
    await runtime.close();
    await expect(turn.done).resolves.toBeUndefined();
  });

  test("an interrupted turn reports aborted rather than completed", async () => {
    const events: StreamEvent[] = [];
    const runtime = makeRuntime(
      `
      setOnLine((m) => {
        if (m.method === "initialize") return send({ id: m.id, result: {} });
        if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: "t" } } });
        if (m.method === "turn/start") {
          send({ id: m.id, result: { turn: { id: "turn-1" } } });
          send({ method: "turn/started", params: { threadId: "t", turn: { id: "turn-1" } } });
          return;
        }
        if (m.method === "turn/interrupt") {
          send({ id: m.id, result: {} });
          send({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn-1", status: "interrupted" } } });
          return;
        }
      });
    `,
      (event) => events.push(event),
    );
    await runtime.start();
    const turn = await runtime.send("hi");
    await runtime.interrupt();
    await turn.done;
    expect(events.at(-1)).toEqual({ type: "turn_complete", reason: "aborted_streaming" });
  });

  test("a failed interrupt surfaces rather than being swallowed", async () => {
    // A stop the user asked for that did not land must not look like it did.
    const runtime = makeRuntime(`
      setOnLine((m) => {
        if (m.method === "initialize") return send({ id: m.id, result: {} });
        if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: "t" } } });
        if (m.method === "turn/start") return send({ id: m.id, result: { turn: { id: "turn-1" } } });
        if (m.method === "turn/interrupt") return send({ id: m.id, error: { code: -1, message: "nope" } });
      });
    `);
    await runtime.start();
    await runtime.send("hi");
    await expect(runtime.interrupt()).rejects.toThrow(/nope/);
  });

  test("a native tool approval defaults to decline", async () => {
    // An unanswered or unconfigured approval must never become an implicit yes.
    const runtime = makeRuntime(`
      let decision = null;
      setOnLine((m) => {
        if (m.method === "initialize") return send({ id: m.id, result: {} });
        if (m.method === "thread/start") {
          send({ id: m.id, result: { thread: { id: "t" } } });
          send({ id: 500, method: "item/commandExecution/requestApproval", params: { cmd: "rm -rf /" } });
          return;
        }
        if (m.method === "collect") return send({ id: m.id, result: { decision } });
        if (m.result && m.result.decision) decision = m.result.decision;
      });
    `);
    await runtime.start();
    await Bun.sleep(250);
    // Reach through to the client to read what the fake recorded.
    const collected = (await (
      runtime as unknown as { client: { request(m: string): Promise<unknown> } }
    ).client.request("collect")) as { decision?: string };
    expect(collected.decision).toBe("decline");
  });

  test("a configured approval hook decides instead", async () => {
    const file = fakeServerScript(`
      let decision = null;
      setOnLine((m) => {
        if (m.method === "initialize") return send({ id: m.id, result: {} });
        if (m.method === "thread/start") {
          send({ id: m.id, result: { thread: { id: "t" } } });
          send({ id: 501, method: "item/fileChange/requestApproval", params: {} });
          return;
        }
        if (m.method === "collect") return send({ id: m.id, result: { decision } });
        if (m.result && m.result.decision) decision = m.result.decision;
      });
    `);
    const runtime = new CodexRuntime(
      {
        cwd: process.cwd(),
        businessSessionId: "sess-hook",
        bridge,
        client: { command: process.execPath, args: [file] },
      },
      { onNativeApproval: () => "accept" },
    );
    runtimes.push(runtime);
    await runtime.start();
    await Bun.sleep(250);
    const collected = (await (
      runtime as unknown as { client: { request(m: string): Promise<unknown> } }
    ).client.request("collect")) as { decision?: string };
    expect(collected.decision).toBe("accept");
  });

  describe("MCP approval elicitation (how Codex asks about OUR tools)", () => {
    /** Ask for an elicitation decision and report what the fake received. */
    function elicitationProbe(params: Record<string, unknown>, serverName?: string) {
      const file = fakeServerScript(`
        let answer = null;
        setOnLine((m) => {
          if (m.method === "initialize") return send({ id: m.id, result: {} });
          if (m.method === "thread/start") {
            send({ id: m.id, result: { thread: { id: "t" } } });
            send({ id: 700, method: "mcpServer/elicitation/request", params: ${JSON.stringify(params)} });
            return;
          }
          if (m.method === "collect") return send({ id: m.id, result: { answer } });
          if (m.result && m.result.action) answer = m.result;
        });
      `);
      const runtime = new CodexRuntime({
        cwd: process.cwd(),
        businessSessionId: "sess-elicit",
        bridge,
        ...(serverName ? { bridgeServerName: serverName } : {}),
        client: { command: process.execPath, args: [file] },
      });
      runtimes.push(runtime);
      return runtime;
    }

    async function collect(runtime: CodexRuntime): Promise<{ action?: string } | null> {
      await runtime.start();
      await Bun.sleep(250);
      const result = (await (
        runtime as unknown as { client: { request(m: string): Promise<unknown> } }
      ).client.request("collect")) as { answer?: { action?: string } | null };
      return result.answer ?? null;
    }

    test("accepts an approval elicitation for CodeShell's own server", async () => {
      // Measured against real codex-cli 0.145.0: Codex asks about OUR MCP server's
      // tools through `mcpServer/elicitation/request`, NOT
      // `item/permissions/requestApproval`. Leaving it unhandled made the
      // app-server log `unhandled: mcpServer/elicitation/request` and the model
      // report the call as "rejected" — the reverse channel silently never fired.
      const runtime = elicitationProbe({
        serverName: "codeshell_tools",
        message: "Run Panel?",
        mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "Panel" },
      });
      expect(await collect(runtime)).toMatchObject({ action: "accept" });
    });

    test("declines an elicitation from a THIRD-PARTY server", async () => {
      // Not ours to consent to. A blanket accept here would hand the runtime a
      // yes for any server it can name.
      const runtime = elicitationProbe({
        serverName: "figma",
        message: "Run get_file?",
        mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "get_file" },
      });
      expect(await collect(runtime)).toMatchObject({ action: "decline" });
    });

    test("declines an elicitation whose kind is not a tool-call approval", async () => {
      // An elicitation we do not recognise is not an approval we can grant.
      const runtime = elicitationProbe({
        serverName: "codeshell_tools",
        message: "Enter your API key",
        mode: "form",
        _meta: { codex_approval_kind: "credentials" },
      });
      expect(await collect(runtime)).toMatchObject({ action: "decline" });
    });

    test("declines when _meta is missing entirely", async () => {
      const runtime = elicitationProbe({ serverName: "codeshell_tools", mode: "form" });
      expect(await collect(runtime)).toMatchObject({ action: "decline" });
    });

    test("respects a custom bridge server name", async () => {
      const runtime = elicitationProbe(
        {
          serverName: "other_tools",
          mode: "form",
          _meta: { codex_approval_kind: "mcp_tool_call" },
        },
        "other_tools",
      );
      expect(await collect(runtime)).toMatchObject({ action: "accept" });
    });

    test("does not persist consent for the session", async () => {
      // `_meta: null` — each call is authorized on its own merits by ToolExecutor,
      // so a session-level "always allow" would bypass per-call authorization.
      const runtime = elicitationProbe({
        serverName: "codeshell_tools",
        mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call", persist: "session" },
      });
      const answer = (await collect(runtime)) as { _meta?: unknown } | null;
      expect(answer?._meta ?? null).toBeNull();
    });
  });

  test("an event handler that throws does not break the turn", async () => {
    const runtime = makeRuntime(HAPPY_PATH, () => {
      throw new Error("ui exploded");
    });
    await runtime.start();
    const turn = await runtime.send("hi");
    await expect(turn.done).resolves.toBeUndefined();
  });
});
