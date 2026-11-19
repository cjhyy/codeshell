import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundJobProgress } from "@cjhyy/code-shell-core/extension";
import {
  CODEX_WORKER_APPROVAL_POLICY,
  codexWorkerSandbox,
  runCodexWorkerOnce,
} from "./drive-agent-codex-worker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake `codex app-server`: NDJSON over stdio, no `jsonrpc` field. */
function fakeAppServer(body: string): { command: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-fake-codex-worker-"));
  dirs.push(dir);
  const file = join(dir, "server.mjs");
  writeFileSync(
    file,
    `import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let threadId = "thread-worker-1";
const note = (method, params) => send({ method, params: { threadId, turnId: "turn-1", ...params } });
const say = (text) => note("item/completed", { item: { type: "agentMessage", id: "m" + Math.random(), text } });
const finish = (status = "completed", error = null) =>
  send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status, error } } });
let threadParams, turnParams;
const answers = new Map();
let onTurn = () => finish();
createInterface({ input: process.stdin }).on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === "initialize") return send({ id: m.id, result: { userAgent: "fake/0.162.0" } });
  if (m.method === "thread/resume") {
    if (m.params.threadId === "gone") return send({ id: m.id, error: { code: -32600, message: "no rollout" } });
    threadParams = m.params;
    threadId = m.params.threadId;
    return send({ id: m.id, result: { thread: { id: threadId } } });
  }
  if (m.method === "thread/start") {
    threadParams = m.params;
    return send({ id: m.id, result: { thread: { id: threadId } } });
  }
  if (m.method === "turn/start") {
    turnParams = m.params;
    send({ id: m.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId, turn: { id: "turn-1" } } });
    return onTurn();
  }
  if (m.method === "turn/interrupt") return send({ id: m.id, result: {} });
  if (m.id !== undefined && !m.method) {
    const resolve = answers.get(m.id);
    answers.delete(m.id);
    resolve?.(m.result ?? m.error);
  }
});
const ask = (id, method, params) =>
  new Promise((resolve) => {
    answers.set(id, resolve);
    send({ id, method, params: { threadId, turnId: "turn-1", startedAtMs: 1, ...params } });
  });
${body}
`,
  );
  return { command: process.execPath, args: [file] };
}

type Ask = { toolName: string; input: Record<string, unknown> };

function run(
  body: string,
  extra: Partial<Parameters<typeof runCodexWorkerOnce>[0]> = {},
  signal?: AbortSignal,
) {
  const asks: Ask[] = [];
  const progress: BackgroundJobProgress[] = [];
  const sessionIds: string[] = [];
  const pids: number[] = [];
  const result = runCodexWorkerOnce(
    {
      prompt: "do the task",
      cwd: process.cwd(),
      permissionMode: "default",
      approve: async (request) => {
        asks.push(request);
        return { approved: true };
      },
      onProgress: (p) => progress.push(p),
      onSessionId: (id) => sessionIds.push(id),
      onProcess: (pid) => pids.push(pid),
      client: fakeAppServer(body),
      ...extra,
    },
    signal,
  );
  return { result, asks, progress, sessionIds, pids };
}

describe("CODEX_WORKER_APPROVAL_POLICY", () => {
  test("keeps every approval flow open, sandbox failures included", () => {
    expect(CODEX_WORKER_APPROVAL_POLICY).toEqual({
      granular: {
        sandbox_approval: true,
        rules: true,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: true,
      },
    });
  });
});

describe("codexWorkerSandbox", () => {
  test("default asks before writes; acceptEdits confines writes to the workspace", () => {
    expect(codexWorkerSandbox("default")).toBe("read-only");
    expect(codexWorkerSandbox("acceptEdits")).toBe("workspace-write");
  });
});

describe("runCodexWorkerOnce", () => {
  test("opens a sandboxed thread that asks on a sandbox failure and returns the last agent message", async () => {
    const { result, sessionIds, pids, progress } = run(
      `onTurn = () => {
        note("item/started", { item: { type: "commandExecution", id: "c1", command: "ls" } });
        note("item/completed", { item: { type: "commandExecution", id: "c1", command: "ls", exitCode: 0 } });
        say("looking");
        say(JSON.stringify({ threadParams, input: turnParams.input }));
        finish();
      };`,
      { permissionMode: "acceptEdits", model: "some-model", imagePaths: ["/tmp/shot.png"] },
    );
    const r = await result;
    expect(r).toMatchObject({ sessionId: "thread-worker-1", isError: false, exitCode: 0 });
    const seen = JSON.parse(r.finalText);
    expect(seen.threadParams).toMatchObject({
      cwd: process.cwd(),
      sandbox: "workspace-write",
      approvalPolicy: CODEX_WORKER_APPROVAL_POLICY,
      model: "some-model",
    });
    expect(seen.input[0]).toMatchObject({ type: "text" });
    expect(seen.input[0].text).toContain("do the task");
    expect(seen.input[1]).toEqual({ type: "localImage", path: "/tmp/shot.png" });
    expect(sessionIds).toEqual(["thread-worker-1"]);
    expect(pids).toHaveLength(1);
    const summaries = progress.flatMap((p) => (p.recentEvents ?? []).map((e) => e.summary));
    expect(summaries).toContain("Codex session connected");
    expect(summaries).toContain("Command finished (exit 0)");
    expect(progress.at(-1)?.summary).toBe("Response complete");
  });

  test("routes a command approval to the host and returns its answer to Codex", async () => {
    const body = `onTurn = async () => {
      const answer = await ask(900, "item/commandExecution/requestApproval", {
        itemId: "c1", command: "git commit -m x", cwd: "/repo", reason: "writes .git" });
      say(JSON.stringify(answer));
      finish();
    };`;
    const accepted = run(body);
    expect(JSON.parse((await accepted.result).finalText)).toEqual({ decision: "accept" });
    expect(accepted.asks).toEqual([
      {
        toolName: "shell",
        input: { command: "git commit -m x", cwd: "/repo", reason: "writes .git" },
      },
    ]);
    const declined = run(body, { approve: async () => ({ approved: false }) });
    expect(JSON.parse((await declined.result).finalText)).toEqual({ decision: "decline" });
  });

  // Captured from codex-cli 0.162.0 in a `workspace-write` sandbox: asking for
  // network is an ordinary command approval. There is no `networkApprovalContext`
  // (that belongs to Codex's managed network proxy, off by default); the first,
  // sandboxed attempt is a plain failed item of its own.
  test("a network request arrives as a command approval for a second item", async () => {
    const curl = `/bin/zsh -lc "curl -sS -o /dev/null -w '%{http_code}' https://example.com"`;
    const body = `const command = ${JSON.stringify(curl)};
      const item = (id, extra) => ({ type: "commandExecution", id, pluginId: null, scriptPath: null,
        command, cwd: "/repo", processId: null, source: "agent", status: "inProgress",
        commandActions: [{ type: "unknown", command: "curl" }],
        aggregatedOutput: null, exitCode: null, durationMs: null, ...extra });
      onTurn = async () => {
        note("item/completed", { item: item("exec-f0d5cb13", { processId: "36371",
          source: "unifiedExecStartup", status: "failed", exitCode: 6,
          aggregatedOutput: "curl: (6) Could not resolve host: example.com\\n000" }) });
        note("item/started", { item: item("exec-84bd1ce0") });
        const answer = await ask(0, "item/commandExecution/requestApproval", {
          kind: "command", itemId: "exec-84bd1ce0", environmentId: "local",
          reason: "May I allow network access to run the requested curl command?",
          command, cwd: "/repo", commandActions: [{ type: "unknown", command: "curl" }],
          availableDecisions: ["accept", "cancel"] });
        note("item/completed", { item: answer.decision === "accept"
          ? item("exec-84bd1ce0", { processId: "50644", source: "unifiedExecStartup",
              status: "completed", exitCode: 0, aggregatedOutput: "200", durationMs: 326 })
          : item("exec-84bd1ce0", { status: "declined" }) });
        say(answer.decision);
        finish();
      };`;
    const accepted = run(body, { permissionMode: "acceptEdits" });
    expect(await accepted.result).toMatchObject({ isError: false, finalText: "accept" });
    expect(accepted.asks).toEqual([
      {
        toolName: "shell",
        input: {
          command: curl,
          cwd: "/repo",
          reason: "May I allow network access to run the requested curl command?",
        },
      },
    ]);
    const declined = run(body, {
      permissionMode: "acceptEdits",
      approve: async () => ({ approved: false }),
    });
    const refused = await declined.result;
    expect(refused).toMatchObject({ isError: false, finalText: "decline" });
    // The sandboxed attempt merely failed and the second was the gate's to refuse.
    expect(refused.sandboxBlocked).toBeUndefined();
  });

  test("names the files of a patch under approval", async () => {
    const { result, asks } = run(`onTurn = async () => {
      note("item/started", { item: { type: "fileChange", id: "p1", status: "inProgress",
        changes: [{ path: "/repo/a.ts", kind: { type: "add" }, diff: "SECRET" }] } });
      await ask(901, "item/fileChange/requestApproval", { itemId: "p1", reason: null, grantRoot: null });
      finish();
    };`);
    await result;
    expect(asks).toEqual([{ toolName: "apply_patch", input: { files: ["add /repo/a.ts"] } }]);
  });

  test("answers a permission request with the granted profile, or nothing", async () => {
    const body = `onTurn = async () => {
      say(JSON.stringify(await ask(902, "item/permissions/requestApproval", {
        itemId: "x", cwd: "/repo", permissions: { network: { enabled: true }, fileSystem: null } })));
      finish();
    };`;
    const granted = run(body);
    expect(JSON.parse((await granted.result).finalText)).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
    });
    expect(granted.asks[0]).toMatchObject({ toolName: "permissions" });
    const refused = run(body, { approve: async () => ({ approved: false }) });
    expect(JSON.parse((await refused.result).finalText)).toEqual({
      permissions: {},
      scope: "turn",
    });
  });

  test("routes a tool-call elicitation from a user-configured MCP server", async () => {
    const { result, asks } = run(`onTurn = async () => {
      say(JSON.stringify(await ask(903, "mcpServer/elicitation/request", {
        serverName: "github", message: "Allow create_issue?",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "create_issue" } })));
      finish();
    };`);
    expect(JSON.parse((await result).finalText)).toMatchObject({ action: "accept" });
    expect(asks).toEqual([
      { toolName: "mcp__github__create_issue", input: { message: "Allow create_issue?" } },
    ]);
  });

  test("no MCP server is trusted by name: the worker has no CodeShell bridge", async () => {
    const { result, asks } = run(
      `onTurn = async () => {
      say(JSON.stringify(await ask(905, "mcpServer/elicitation/request", {
        serverName: "codeshell_tools", message: "m",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "Bash" } })));
      finish();
    };`,
      { approve: async (request) => (asks.push(request), { approved: false }) },
    );
    expect(JSON.parse((await result).finalText)).toMatchObject({ action: "decline" });
    expect(asks.map((ask) => ask.toolName)).toEqual(["mcp__codeshell_tools__Bash"]);
  });

  test("reports the files of the patches Codex applied, not of one it was refused", async () => {
    const { result, progress } = run(
      `const patch = (id, status, changes) =>
        note("item/completed", { item: { type: "fileChange", id, status, changes } });
      onTurn = async () => {
        await ask(910, "item/fileChange/requestApproval", { itemId: "p1", reason: null, grantRoot: null });
        patch("p1", "completed", [
          { path: "/repo/note.txt", kind: { type: "add" }, diff: "hi" },
          { path: "/repo/old.ts", kind: { type: "update", move_path: "/repo/new.ts" }, diff: "" },
        ]);
        await ask(911, "item/fileChange/requestApproval", { itemId: "p2", reason: null, grantRoot: null });
        patch("p2", "declined", [{ path: "/repo/refused.txt", kind: { type: "add" }, diff: "" }]);
        patch("p3", "failed", [{ path: "/repo/failed.txt", kind: { type: "add" }, diff: "" }]);
        say("done");
        finish();
      };`,
    );
    const r = await result;
    expect(r.changedFiles).toEqual(["/repo/note.txt", "/repo/old.ts", "/repo/new.ts"]);
    expect(r.sandboxBlocked).toBeUndefined();
    expect(progress.at(-1)?.sandboxBlocked).toBeUndefined();
  });

  describe("operations Codex refuses without asking", () => {
    test("a command or patch declined with no approval request is counted as sandbox-blocked", async () => {
      const { result, asks, progress } = run(`onTurn = () => {
        note("item/completed", { item: { type: "commandExecution", id: "c1", command: "rm -rf /",
          status: "declined", exitCode: null } });
        note("item/completed", { item: { type: "fileChange", id: "p1", status: "declined",
          changes: [{ path: "/etc/hosts", kind: { type: "update", move_path: null }, diff: "" }] } });
        say("could not");
        finish();
      };`);
      const r = await result;
      expect(asks).toEqual([]);
      expect(r).toMatchObject({ isError: false, finalText: "could not", sandboxBlocked: 2 });
      expect(r.changedFiles).toBeUndefined();
      expect(progress.at(-1)?.sandboxBlocked).toBe(2);
      const summaries = progress.flatMap((p) => (p.recentEvents ?? []).map((e) => e.summary));
      expect(summaries).toContain("1 operation(s) blocked by the sandbox");
      expect(summaries).toContain("2 operation(s) blocked by the sandbox");
    });

    test("a refusal the gate answered is the gate's denial, not a sandbox block", async () => {
      const { result, asks } = run(
        `onTurn = async () => {
        await ask(920, "item/commandExecution/requestApproval", { itemId: "c1", command: "git push" });
        note("item/completed", { item: { type: "commandExecution", id: "c1", command: "git push",
          status: "declined", exitCode: null } });
        finish();
      };`,
        { approve: async (request) => (asks.push(request), { approved: false }) },
      );
      expect((await result).sandboxBlocked).toBeUndefined();
      expect(asks).toHaveLength(1);
    });

    // Captured from codex-cli 0.162.0 (`touch blocked.txt`, read-only sandbox,
    // the worker's approval policy): the command ran in the sandbox, was
    // stopped by it, and Codex asks to run it again outside.
    test("a command the sandbox stopped is put to the gate, so it is never silent", async () => {
      const body = `const item = (status, extra) => ({ type: "commandExecution",
        id: "exec-8ed1fa07", pluginId: null, scriptPath: null,
        command: "/bin/zsh -lc 'touch blocked.txt'", cwd: "/repo", processId: null, source: "agent",
        status, commandActions: [{ type: "unknown", command: "touch blocked.txt" }],
        aggregatedOutput: null, exitCode: null, durationMs: null, ...extra });
      onTurn = async () => {
        note("item/started", { item: item("inProgress") });
        const answer = await ask(0, "item/commandExecution/requestApproval", {
          kind: "command", itemId: "exec-8ed1fa07", environmentId: "local",
          reason: "command failed; retry without sandbox?",
          command: "/bin/zsh -lc 'touch blocked.txt'", cwd: "/repo",
          commandActions: [{ type: "unknown", command: "touch blocked.txt" }],
          proposedExecpolicyAmendment: ["touch", "blocked.txt"],
          availableDecisions: ["accept", { acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["touch", "blocked.txt"] } }, "cancel"] });
        send({ method: "serverRequest/resolved", params: { threadId, requestId: 0 } });
        note("item/completed", { item: answer.decision === "accept"
          ? item("completed", { processId: "13038", source: "unifiedExecStartup", exitCode: 0, durationMs: 0 })
          : item("declined") });
        say(answer.decision);
        finish();
      };`;
      const declined = run(body, { approve: async () => ({ approved: false }) });
      const refused = await declined.result;
      expect(refused).toMatchObject({ isError: false, finalText: "decline" });
      // The gate answered it, so it is the gate's denial and not a silent block.
      expect(refused.sandboxBlocked).toBeUndefined();
      const refusedEvents = declined.progress.flatMap((p) =>
        (p.recentEvents ?? []).map((e) => e.summary),
      );
      expect(refusedEvents.filter((summary) => summary.startsWith("Command finished"))).toEqual([]);

      const accepted = run(body);
      expect((await accepted.result).finalText).toBe("accept");
      expect(accepted.asks).toEqual([
        {
          toolName: "shell",
          input: {
            command: "/bin/zsh -lc 'touch blocked.txt'",
            cwd: "/repo",
            reason: "command failed; retry without sandbox?",
          },
        },
      ]);
    });

    // As codex-cli 0.162.0 reports it: an exit code and no cause.
    test("a command that merely failed is not counted", async () => {
      const { result } = run(`onTurn = () => {
        note("item/completed", { item: { type: "commandExecution", id: "c1", command: "sh -c 'exit 3'",
          status: "failed", exitCode: 3, aggregatedOutput: null } });
        finish();
      };`);
      expect((await result).sandboxBlocked).toBeUndefined();
    });

    test("a turn that ends with Codex's sandbox error code is counted", async () => {
      const { result } = run(
        `onTurn = () => finish("failed", { message: "sandbox denied", codexErrorInfo: "sandboxError" });`,
      );
      expect(await result).toMatchObject({ isError: true, sandboxBlocked: 1 });
    });
  });

  test("reports a failed turn as an error with Codex's own message", async () => {
    const { result } = run(
      `onTurn = () => { say("partial"); finish("failed", { message: "model unavailable" }); };`,
    );
    expect(await result).toMatchObject({
      sessionId: "thread-worker-1",
      isError: true,
      finalText: "model unavailable",
      exitCode: 1,
    });
  });

  test("resumes the named thread, and fails rather than silently starting a new one", async () => {
    const resumed = run(`onTurn = () => { say(JSON.stringify(threadParams)); finish(); };`, {
      resumeSessionId: "thread-old",
    });
    const r = await resumed.result;
    expect(r.sessionId).toBe("thread-old");
    expect(JSON.parse(r.finalText)).toMatchObject({
      threadId: "thread-old",
      sandbox: "read-only",
      approvalPolicy: CODEX_WORKER_APPROVAL_POLICY,
    });
    const gone = await run("", { resumeSessionId: "gone" }).result;
    expect(gone).toMatchObject({ sessionId: "gone", isError: true, exitCode: 1 });
    expect(gone.finalText).toContain("could not be resumed");
  });

  test("an abort stops the app-server, cancels a pending ask, and still resolves", async () => {
    const controller = new AbortController();
    let askSignal: AbortSignal | undefined;
    const { result, pids } = run(
      `onTurn = async () => { await ask(904, "item/commandExecution/requestApproval", { itemId: "c", command: "sleep 9" }); };`,
      {
        approve: (_request, signal) => {
          askSignal = signal;
          setTimeout(() => controller.abort(), 20);
          return new Promise((resolve) =>
            signal?.addEventListener("abort", () => resolve({ approved: false })),
          );
        },
      },
      controller.signal,
    );
    const r = await result;
    expect(r).toMatchObject({ sessionId: "thread-worker-1", exitCode: null });
    expect(askSignal?.aborted).toBe(true);
    expect(() => process.kill(pids[0]!, 0)).toThrow();
  });

  test("a server that dies mid-turn is an error, not a hang", async () => {
    const { result } = run(`onTurn = () => process.exit(3);`);
    const r = await result;
    expect(r.isError).toBe(true);
    expect(r.finalText).toContain("app-server");
  });

  test("a missing codex binary names the command", async () => {
    const { result } = run("", {
      client: { command: join(tmpdir(), "no-such-codex-binary"), args: [] },
    });
    await expect(result).rejects.toThrow(/no-such-codex-binary/);
  });
});
