import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@cjhyy/code-shell-core";
import { resolveWritePolicy } from "@cjhyy/code-shell-core/internal";
import { WorkerBridgeCore } from "../worker-bridge-core.js";

test("shared Node Worker resumes a durable Session with automation policy then accepts an ordinary turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-worker-policy-"));
  const cwd = join(root, "project"),
    home = join(root, "home"),
    data = join(root, "data");
  const proof = join(cwd, "proof.txt");
  const deniedProof = join(cwd, "must-not-exist.txt");
  const responses: any[] = [],
    errors: unknown[] = [],
    approvals: any[] = [];
  let stage = 0;
  const model = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      responses.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "policy-fixture", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (!body.tools?.length) {
        frame({ role: "assistant", content: "auxiliary" });
        frame({}, "stop");
      } else {
        const current = stage++;
        if (current === 0) {
          frame({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "write-proof",
                type: "function",
                function: {
                  name: "Write",
                  arguments: JSON.stringify({
                    file_path: proof,
                    content: "automation wrote this\n",
                  }),
                },
              },
              {
                index: 1,
                id: "deny-background",
                type: "function",
                function: {
                  name: "Bash",
                  arguments: JSON.stringify({
                    command: `touch '${deniedProof}'`,
                    run_in_background: true,
                  }),
                },
              },
            ],
          });
          frame({}, "tool_calls");
        } else {
          frame({
            role: "assistant",
            content: current === 1 ? "automation complete" : "ordinary turn complete",
          });
          frame({}, "stop");
        }
      }
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      errors.push(error);
      res.destroy();
    });
  });
  let exited = false;
  const bridge = new WorkerBridgeCore({
    entryPath: createRequire(import.meta.url).resolve(
      "@cjhyy/code-shell-core/bin/agent-server-stdio",
    ),
    execPath: "node",
    fallbackCwd: () => cwd,
    buildEnv: () => ({
      PATH: process.env.PATH,
      HOME: home,
      CODE_SHELL_HOME: join(home, ".code-shell"),
      CODE_SHELL_DATA_ROOT: data,
      CODE_SHELL_CREDENTIAL_ACCESS: "local",
      CODE_SHELL_CAPABILITY_MODULES: `${import.meta.resolve("@cjhyy/code-shell-capability-coding")}#createCodingModule`,
    }),
    onExit: () => {
      exited = true;
    },
    onSpawnError: () => {
      exited = true;
    },
  });
  let rpcId = 0;
  const rpc = (method: string, params: unknown) =>
    bridge.request(method, params, {
      id: `policy-${++rpcId}`,
      timeoutMs: 15000,
      consume: true,
      settleOnExit: true,
      failFast: true,
      ...(method === "agent/run" ? { waitForRunCompletion: true } : {}),
      meta: { origin: "host", producer: "automation-policy-integration" },
    });
  const policy = resolveWritePolicy("full");
  const pending: Promise<unknown>[] = [];
  const unsubscribe = bridge.subscribeLines((line) => {
    const message = JSON.parse(line);
    if (message.method !== "agent/approvalRequest") return;
    const { request, ...identity } = message.params;
    approvals.push(request);
    pending.push(
      (async () => {
        const decision = request.toolName.startsWith("__")
          ? { approved: false, failure: "unavailable", reason: "No interactive page" }
          : await policy.approvalBackend.requestApproval(request);
        const outcome = await rpc("agent/approve", { ...identity, decision });
        if (outcome.status !== "result") errors.push(outcome);
      })(),
    );
  });
  try {
    await mkdir(join(cwd, ".code-shell"), { recursive: true });
    await mkdir(home, { recursive: true });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const port = (model.address() as { port: number }).port;
    await writeFile(
      join(cwd, ".code-shell/settings.local.json"),
      JSON.stringify({
        credentials: [
          {
            id: "fixture-key",
            catalogId: "openai",
            apiKey: "fixture",
            baseUrl: `http://127.0.0.1:${port}/v1`,
          },
        ],
        modelConnections: [
          {
            id: "policy-fixture",
            catalogId: "openai",
            tag: "text",
            model: "gpt-4o-mini",
            credentialId: "fixture-key",
          },
        ],
        defaults: { text: "policy-fixture" },
        permissions: {
          defaultMode: "default",
          rules: [
            { tool: "Write", decision: "ask" },
            { tool: "Bash", decision: "ask" },
          ],
        },
        sandbox: { mode: "off" },
        autoUpdates: false,
      }),
    );
    const manager = new SessionManager(join(data, "sessions"));
    const sessionId = manager.create(cwd, "gpt-4o-mini", "openai").state.sessionId;
    bridge.ensureWorker(cwd);
    const generation = bridge.workerGeneration();
    const run = await rpc("agent/run", {
      sessionId,
      cwd,
      task: "Write the proof and attempt the background command.",
      model: "policy-fixture",
      requireExisting: true,
      permissionMode: policy.permissionMode,
      sandboxMode: policy.sandboxMode,
      allowBackgroundShells: false,
      toolAllowlist: ["Write", "Bash"],
      disableGoal: true,
      clientMessageId: "automation-first",
    });
    expect(run).toMatchObject({ status: "result", result: { reason: "completed", sessionId } });
    expect(await readFile(proof, "utf8")).toBe("automation wrote this\n");
    expect(await readFile(deniedProof, "utf8").catch(() => null)).toBeNull();
    expect(JSON.stringify(responses)).toContain("background shells are not available");
    expect(approvals.some((request) => request.toolName === "Write")).toBe(true);
    const next = await rpc("agent/run", {
      sessionId,
      cwd,
      task: "Continue the ordinary conversation.",
      model: "policy-fixture",
      requireExisting: true,
      toolAllowlist: ["Write"],
      disableGoal: true,
      clientMessageId: "ordinary-second",
    });
    expect(next).toMatchObject({ status: "result", result: { reason: "completed", sessionId } });
    expect(bridge.workerGeneration()).toBe(generation);
    expect(manager.readSessionState(sessionId)?.cwd).toBe(cwd);
    await Promise.all(pending);
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    bridge.kill();
    const deadline = Date.now() + 5000;
    while (bridge.hasChild() && !exited && Date.now() < deadline) await Bun.sleep(10);
    model.closeAllConnections();
    await new Promise<void>((done) => model.close(() => done()));
    // Preserve the original assertion failure and leave files for a worker that
    // did not exit; the shutdown assertion below applies after successful work.
    if (!bridge.hasChild()) await rm(root, { recursive: true, force: true });
  }
  expect(bridge.hasChild()).toBe(false);
}, 30000);
