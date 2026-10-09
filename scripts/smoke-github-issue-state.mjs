/** Compiled SDK Engine -> production remote Link adapter -> owned HTTP fixture.
 * Synthetic provider/account only. No sibling Services source or real GitHub request.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";
import { confinedWorkerEnvironment } from "./runtime-cost-smoke-isolation.mjs";

const actions = ["get_repository", "get_issue", "update_issue"];
const cases = ["close", "reopen", "noop", "repository", "issue", "pr", "unknown"];
const connectionId = "11111111-1111-4111-8111-111111111111";
const grantId = "22222222-2222-4222-8222-222222222222";
if (process.argv[2] === "--worker") {
  process.stdin.setEncoding("utf8");
  assert.equal(String((await once(process.stdin, "data"))[0]).trim(), "start");
  const root = process.env.AGENT_CWD;
  const origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
  // Probe the already-installed guard before Core can observe any fixture authority.
  await assert.rejects(
    async () => fetch("https://issue-state-denied.invalid/probe"),
    /non-fixture request/,
  );
  // This import happens only after the parent has verified the preload receipt.
  const core = await import("@cjhyy/code-shell-core");
  const store = new core.CredentialStore(root, new core.PlaintextCipher(), join(root, "custody"));
  if (process.argv[3] !== "--resume") {
    const attempt = core.beginRemoteLinkAuthorization(
      { issuer: origin, clientId: "synthetic-client", redirectUri: `${origin}/callback` },
      Date.now(),
      { providerId: "github", actions },
    );
    const credential = await core.completeRemoteLinkAuthorization(
      attempt,
      `${origin}/callback?code=synthetic-once&state=${attempt.state}`,
      "fixture-link",
      "Synthetic",
    );
    store.save("project", credential);
  }
  core.setDefaultCredentialAccess({
    listMasked: () => store.listMasked(),
    resolveMeta: (_cwd, id) => store.listMasked().find((item) => item.id === id),
    envExposures: () => ({}),
    resolveValue: async () => {
      throw new Error("No upstream credential is available to this Host");
    },
    executeRemoteLinkAction: (input) => core.executeRemoteLinkAction(input, { store }),
  });
  class FixtureProvider extends core.LLMClientBase {
    initClient() {}
    async createMessage(request) {
      const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
      this.recordUsage(usage, request);
      const latest = request.messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("fixture "),
      );
      const mode = request.messages[latest].content.split(" ")[1];
      assert.ok(cases.includes(mode));
      const results = request.messages
        .slice(latest + 1)
        .flatMap((message) =>
          message.role === "user" && Array.isArray(message.content)
            ? message.content.filter((block) => block.type === "tool_result")
            : [],
        );
      if (!(request.tools ?? []).some((tool) => tool.name === "LinkAction")) {
        assert.ok((request.tools ?? []).some((tool) => tool.name === "ToolSearch"));
        return {
          text: "Select the issue state adapter",
          stopReason: "tool_use",
          usage,
          toolCalls: [
            { id: "fixture-select", toolName: "ToolSearch", args: { query: "select:LinkAction" } },
          ],
        };
      }
      assert.match(
        JSON.stringify(results.find((block) => block.tool_use_id === "fixture-select")),
        /schemaRef: select:LinkAction/,
      );
      return results.some((block) => block.tool_use_id === "fixture-state")
        ? { text: "Model claims success", stopReason: "stop", usage, toolCalls: [] }
        : {
            text: "Set one synthetic issue state",
            stopReason: "tool_use",
            usage,
            toolCalls: [
              {
                id: "fixture-state",
                toolName: "LinkAction",
                args: {
                  provider: "github",
                  action: "update_issue",
                  connectionId: "fixture-link",
                  params: {
                    owner: "fixture",
                    repo: mode,
                    issue_number: 7,
                    state: mode === "reopen" ? "open" : "closed",
                  },
                },
              },
            ],
          };
    }
  }
  core.registerProvider("issue-state-fixture", FixtureProvider);
  const engine = new core.Engine({
    llm: { provider: "issue-state-fixture", model: "synthetic", apiKey: "synthetic" },
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    enabledBuiltinTools: ["LinkAction"],
    maxTurns: 4,
    headless: true,
    isSubAgent: true,
    permissionMode: "bypassPermissions",
    askUser: async () => "允许执行",
    behaviorProfiles: [
      {
        id: "fixture",
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
  try {
    for (const mode of process.argv[3] === "--resume"
      ? ["unknown", "repository", "issue"]
      : cases) {
      const events = [];
      const output = await engine.run(`fixture ${mode}`, {
        sessionId: `${mode}-session`,
        clientMessageId: `${mode}-${process.argv[3] === "--resume" ? "continue" : "input"}`,
        behaviorMode: "fixture",
        onStream: (event) => events.push(event),
      });
      const unverified = ["unknown", "repository", "issue"].includes(mode);
      assert.equal(output.reason, unverified ? "unverified_write" : "completed", mode);
      if (unverified) {
        assert.ok(output.text.includes("尚未通过独立回读验证"));
        assert.ok(
          events.some(
            (event) => event.type === "turn_complete" && event.reason === "unverified_write",
          ),
        );
        assert.equal(
          JSON.parse(readFileSync(join(root, `sessions/${mode}-session/state.json`))).status,
          "unverified_write",
        );
      }
      const transcript = readFileSync(
        join(root, `sessions/${mode}-session/transcript.jsonl`),
        "utf8",
      );
      if (["close", "reopen", "noop"].includes(mode)) {
        assert.ok(transcript.includes("verified"));
        assert.ok(
          transcript.includes(
            `123/456/7/${mode === "reopen" ? "open" : "closed"}/${mode === "noop" ? "unchanged" : "changed"}`,
          ),
          `${mode}: ${transcript.slice(-5000)}`,
        );
      }
      if (mode === "pr") assert.ok(transcript.includes("blocked"));
    }
  } finally {
    await engine.dispose();
    core.setDefaultCredentialAccess(null);
  }
  process.stdout.write("compiled issue state lifecycle passed\n");
  process.stdin.destroy();
} else {
  const root = mkdtempSync(join(tmpdir(), "codeshell-issue-state-sdk-"));
  const calls = [],
    mutations = new Set();
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(raw))
      : JSON.parse(raw || "{}");
    response.setHeader("content-type", "application/json");
    if (request.url === "/oauth/token") {
      assert.equal(body.grant_type, "authorization_code");
      response.end(
        JSON.stringify({
          access_token: "synthetic-downstream",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: actions.map((action) => `github:${action}`).join(" "),
        }),
      );
      return;
    }
    if (request.url === "/api/v1/data/authorization") {
      const resources = [
        {
          id: "repositories",
          items: cases.map((mode) => ({ id: `fixture/${mode}`, label: `Synthetic ${mode}` })),
        },
      ];
      response.end(
        JSON.stringify({
          version: 1,
          providerId: "github",
          connectionId,
          grantId,
          account: { id: "fixture-account", login: "fixture" },
          actions,
          scopes: actions.map((action) => `github:${action}`),
          resourceGroups: resources,
        }),
      );
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer synthetic-downstream");
    const action = request.url.split("/").at(-1);
    assert.ok(actions.includes(action));
    const repository = body.repository ?? `${body.owner}/${body.repo}`;
    const mode = repository.split("/")[1];
    assert.ok(cases.includes(mode));
    calls.push({ action, mode, body });
    let result;
    if (action === "update_issue") {
      assert.deepEqual(body, {
        repository: `fixture/${mode}`,
        issue_number: 7,
        state: mode === "reopen" ? "open" : "closed",
      });
      assert.ok(!mutations.has(mode), "a second physical action was sent");
      mutations.add(mode);
      if (mode === "unknown") {
        request.socket.destroy();
        return;
      }
      result = { acknowledged: true };
    } else if (action === "get_repository") {
      result = {
        id: mode === "repository" && mutations.has(mode) ? 999 : 123,
        full_name: repository,
      };
    } else {
      assert.equal(body.number, 7);
      result = {
        id: mode === "issue" && mutations.has(mode) ? 999 : 456,
        number: 7,
        url: `https://api.github.com/repos/${repository}/issues/7`,
        repository_url: `https://api.github.com/repos/${repository}`,
        state:
          mode === "reopen"
            ? mutations.has(mode)
              ? "open"
              : "closed"
            : mode === "noop" || mutations.has(mode)
              ? "closed"
              : "open",
        ...(mode === "pr" ? { pull_request: {} } : {}),
      };
    }
    response.end(JSON.stringify({ result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`,
    home = join(root, "home"),
    receiptFile = join(root, "guards.jsonl");
  mkdirSync(join(home, ".code-shell"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".code-shell/settings.json"), "{}", { mode: 0o600 });
  const env = {
    ...confinedWorkerEnvironment(
      createBunTestEnvironment(process.env, root),
      home,
      origin,
      new URL("./runtime-cost-smoke-isolation.mjs", import.meta.url).href,
    ),
    AGENT_CWD: root,
    CODE_SHELL_DATA_ROOT: join(root, "data"),
    CODESHELL_COST_SMOKE_GUARD_LOG: receiptFile,
    CODE_SHELL_CAPABILITY_MODULES: "",
    CODE_SHELL_DEV: "0",
    CODESHELL_SELF_UPDATE_CHECK: "0",
  };
  try {
    for (const resume of [false, true]) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "--worker", ...(resume ? ["--resume"] : [])],
        { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (data) => (output += String(data)));
      child.stderr.on("data", (data) => (output += String(data)));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
      try {
        let receipt;
        for (let i = 0; i < 100; i++) {
          if (existsSync(receiptFile))
            receipt = readFileSync(receiptFile, "utf8")
              .trim()
              .split("\n")
              .map(JSON.parse)
              .find((item) => item.pid === child.pid);
          if (receipt) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(receipt, "missing pre-import receipt");
        assert.equal(receipt.ppid, process.pid);
        assert.equal(receipt.origin, origin);
        assert.equal(receipt.homeId, createHash("sha256").update(home).digest("hex"));
        const exited = once(child, "exit");
        child.stdin.write("start\n");
        const [code] = await exited;
        assert.equal(code, 0, output.slice(-6000));
        assert.ok(output.includes("compiled issue state lifecycle passed"));
        process.stdout.write(`guarded worker ${JSON.stringify(receipt)} resume=${resume}\n`);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit");
        }
      }
    }
    for (const mode of ["close", "reopen", "issue"])
      assert.deepEqual(
        calls.filter((call) => call.mode === mode).map((call) => call.action),
        ["get_repository", "get_issue", "update_issue", "get_repository", "get_issue"],
      );
    assert.deepEqual(
      calls.filter((call) => call.mode === "noop").map((call) => call.action),
      ["get_repository", "get_issue", "get_repository", "get_issue"],
    );
    assert.deepEqual(
      calls.filter((call) => call.mode === "repository").map((call) => call.action),
      ["get_repository", "get_issue", "update_issue", "get_repository"],
    );
    assert.deepEqual(
      calls.filter((call) => call.mode === "pr").map((call) => call.action),
      ["get_repository", "get_issue"],
    );
    assert.deepEqual(
      calls.filter((call) => call.mode === "unknown").map((call) => call.action),
      ["get_repository", "get_issue", "update_issue"],
    );
    process.stdout.write(
      "GitHub issue state smoke passed: compiled Engine/ToolSearch, production remote adapter, independent IDs/state, PR/no-op, real process restart and zero duplicate sends.\n",
    );
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  }
}
