import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { confinedWorkerEnvironment } from "./runtime-cost-smoke-isolation.mjs";

if (process.argv[2] === "--worker") {
  // The parent checks the pre-bootstrap guard receipt before authorizing import.
  process.stdin.setEncoding("utf8");
  assert.equal(String((await once(process.stdin, "data"))[0]).trim(), "start");
  const root = process.env.AGENT_CWD;
  const origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
  const core = await import("@cjhyy/code-shell-core");
  const credential = {
    id: "fixture-link",
    type: "oauth",
    label: "Synthetic account",
    hasSecret: true,
    oauthStatus: { state: "valid", hasRefreshToken: true, canRefresh: true },
    meta: {
      linkProvider: "github",
      linkAccountId: "fixture-account",
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteState: "connected",
      linkRemoteGrantId: "fixture-grant",
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      linkCapabilityIds: ["github.list_issues", "github.create_issue", "github.get_issue"],
    },
  };
  core.setDefaultCredentialAccess({
    listMasked: () => [credential],
    resolveMeta: () => credential,
    envExposures: () => ({}),
    resolveValue: async () => {
      throw new Error("Fixture must not resolve a raw token");
    },
    executeRemoteLinkAction: async (input) => {
      const response = await fetch(`${origin}/link`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
  });
  class FixtureProvider extends core.LLMClientBase {
    initClient() {}
    async createMessage(request) {
      const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
      this.recordUsage(usage, request);
      const latestIntent = request.messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("fixture "),
      );
      const hasResult = request.messages
        .slice(latestIntent + 1)
        .some(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === "tool_result"),
        );
      const unknown = JSON.stringify(request.messages).includes("fixture unknown");
      return hasResult
        ? { text: "Model claims success", toolCalls: [], stopReason: "stop", usage }
        : {
            text: "Creating the synthetic fixture",
            stopReason: "tool_use",
            usage,
            toolCalls: [
              {
                id: "fixture-create",
                toolName: "LinkAction",
                args: {
                  provider: "github",
                  action: "create_issue",
                  connectionId: credential.id,
                  params: {
                    owner: "fixture",
                    repo: unknown ? "unknown" : "success",
                    title: "Synthetic issue",
                    body: "Synthetic body",
                  },
                },
              },
            ],
          };
    }
  }
  core.registerProvider("verified-write-fixture", FixtureProvider);
  const createEngine = () => {
    // Explicitly confined SDK consumer; no user settings, modules, memory or title.
    const engine = new core.Engine({
      llm: { provider: "verified-write-fixture", model: "synthetic", apiKey: "synthetic" },
      cwd: root,
      sessionStorageDir: join(root, "sessions"),
      settingsScope: "isolated",
      enabledBuiltinTools: ["LinkAction"],
      maxTurns: 3,
      headless: true,
      isSubAgent: true,
      permissionMode: "bypassPermissions",
      askUser: async () => "允许执行",
      behaviorProfiles: [
        {
          id: "verification-fixture",
          disableSessionTitle: true,
          disableHooks: true,
          disableInstructions: true,
          disableMemoryContext: true,
          disableCapabilityContext: true,
          disableSourcesContext: true,
          disableMcp: true,
        },
      ],
    });
    engine.getHookRegistry().clear();
    return engine;
  };
  const engine = createEngine();
  try {
    const verified = await engine.run("fixture success", {
      sessionId: "verified-session",
      clientMessageId: "verified-input",
      behaviorMode: "verification-fixture",
    });
    assert.equal(verified.reason, "completed");
    const events = [];
    const uncertain = await engine.run("fixture unknown", {
      sessionId: "unknown-session",
      clientMessageId: "unknown-input",
      behaviorMode: "verification-fixture",
      onStream: (event) => events.push(event),
    });
    assert.equal(uncertain.reason, "unverified_write");
    assert.ok(uncertain.text.includes("尚未通过独立回读验证"));
    assert.ok(
      events.some((event) => event.type === "turn_complete" && event.reason === "unverified_write"),
    );
    const state = JSON.parse(
      readFileSync(join(root, "sessions/unknown-session/state.json"), "utf8"),
    );
    assert.equal(state.status, "unverified_write");
    const transcript = readFileSync(
      join(root, "sessions/unknown-session/transcript.jsonl"),
      "utf8",
    );
    assert.ok(transcript.includes("尚未通过独立回读验证"));
  } finally {
    await engine.dispose();
  }
  const restarted = createEngine();
  try {
    const resumed = await restarted.run("fixture unknown; continue", {
      sessionId: "unknown-session",
      clientMessageId: "unknown-continue",
      behaviorMode: "verification-fixture",
    });
    assert.equal(resumed.reason, "unverified_write");
  } finally {
    await restarted.dispose();
    core.setDefaultCredentialAccess(null);
  }
  process.stdout.write("compiled SDK Engine verified-write lifecycle passed\n");
  process.stdin.destroy();
} else {
  const root = mkdtempSync(join(tmpdir(), "codeshell-verified-sdk-"));
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body);
    assert.equal(request.url, "/link");
    calls.push(input);
    if (input.action === "create_issue" && input.params.repo === "unknown") {
      request.socket.destroy();
      return;
    }
    const data =
      input.action === "list_issues"
        ? { issues: [] }
        : { number: 7, title: "Synthetic issue", body: "Synthetic body", state: "open" };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = join(root, "private-home"),
    receipts = join(root, "guard-receipts.jsonl");
  mkdirSync(join(home, ".code-shell"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".code-shell/settings.json"), "{}", { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...confinedWorkerEnvironment(
        process.env,
        home,
        origin,
        new URL("./runtime-cost-smoke-isolation.mjs", import.meta.url).href,
      ),
      CODESHELL_COST_SMOKE_GUARD_LOG: receipts,
      CODE_SHELL_DATA_ROOT: join(root, "data"),
      AGENT_CWD: root,
      CODE_SHELL_CAPABILITY_MODULES: "",
      CODE_SHELL_DEV: "0",
      CODESHELL_SELF_UPDATE_CHECK: "0",
    },
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += String(data);
  });
  child.stderr.on("data", (data) => {
    output += String(data);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    for (let i = 0; i < 100 && !existsSync(receipts); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(receipts), "Missing pre-bootstrap guard receipt");
    const receipt = JSON.parse(readFileSync(receipts, "utf8").trim());
    assert.equal(receipt.pid, child.pid);
    assert.equal(receipt.ppid, process.pid);
    assert.equal(receipt.origin, origin);
    assert.equal(receipt.homeId, createHash("sha256").update(home).digest("hex"));
    const exited = once(child, "exit");
    child.stdin.write("start\n");
    const [code] = await exited;
    assert.equal(code, 0, output.slice(-4000));
    assert.deepEqual(
      calls.filter((call) => call.params.repo === "success").map((call) => call.action),
      ["list_issues", "create_issue", "get_issue"],
    );
    assert.deepEqual(
      calls.filter((call) => call.params.repo === "unknown").map((call) => call.action),
      ["list_issues", "create_issue"],
    );
    assert.ok(output.includes("compiled SDK Engine verified-write lifecycle passed"));
    process.stdout.write(
      "Verified Link write smoke passed: actual Node SDK Engine, independent readback, durable correction, restart without duplicate send; guarded worker confirmed.\n",
    );
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  }
}
