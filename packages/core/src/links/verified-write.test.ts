import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultCredentialAccess, type CredentialMetadata } from "../credentials/access.js";
import type { ToolContext } from "../tool-system/context.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { PermissionRule } from "../types.js";
import { OperationLedger } from "../operations/ledger.js";
import { OperationController } from "../operations/controller.js";
import { CapabilityResolver } from "../operations/resolver.js";
import { requestOnce } from "./request-once.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  setDefaultCredentialAccess(null);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(backend: "remote" | "oauth" | "cli" = "remote") {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-verified-write-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  let match = true,
    loseResponse = false,
    revokeAfterValidate = false,
    resolutions = 0;
  let written: Record<string, unknown> | undefined;
  const credential: CredentialMetadata = {
    id: "fixture-connection",
    type: backend === "remote" ? "oauth" : "link",
    label: "Synthetic fixture",
    hasSecret: true,
    oauthStatus: { state: "valid", hasRefreshToken: true, canRefresh: true },
    meta: {
      linkProvider: "github",
      linkAccountId: "42",
      linkAccountLabel: "fixture-account",
      linkExecutionRuntime: backend === "remote" ? "server" : "local",
      linkExecutionBackend:
        backend === "remote" ? "remote" : backend === "cli" ? "cli" : "http-token",
      ...(backend === "remote"
        ? { linkRemoteState: "connected", linkRemoteGrantId: "fixture-grant" }
        : backend === "oauth"
          ? { linkAuthSource: "browser-oauth", linkOAuthState: "connected" }
          : {}),
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      linkCapabilityIds: ["github.list_issues", "github.get_issue", "github.create_issue"],
    },
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as (typeof calls)[number];
    calls.push(input);
    let output: unknown;
    if (input.action === "list_issues") {
      output = { issues: [] };
      if (revokeAfterValidate) credential.meta!.linkCapabilityIds = ["github.create_issue"];
    } else if (input.action === "create_issue") {
      written = {
        number: 7,
        title: input.params.title,
        body: input.params.body ?? "",
        state: "open",
      };
      if (loseResponse) {
        request.socket.destroy();
        return;
      }
      output = { number: 7, title: input.params.title, state: "open" };
    } else if (input.action === "get_issue")
      output = { ...written, ...(match ? {} : { body: "DIFFERENT" }) };
    else {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(output));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(resolve);
        (server as Server).closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Invalid fixture address");
  if (backend === "cli") {
    const previous = process.env.CODESHELL_LINK_CLI_DIR;
    process.env.CODESHELL_LINK_CLI_DIR = join(directory, "managed-cli");
    cleanups.push(() => {
      if (previous === undefined) delete process.env.CODESHELL_LINK_CLI_DIR;
      else process.env.CODESHELL_LINK_CLI_DIR = previous;
    });
    const binDirectory = join(process.env.CODESHELL_LINK_CLI_DIR, "github");
    mkdirSync(binDirectory, { recursive: true });
    const executable = join(binDirectory, "gh");
    writeFileSync(
      executable,
      `#!${process.execPath}
const http = require("node:http");
const args = process.argv.slice(2), endpoint = args[1];
if (endpoint === "user") { process.stdout.write(JSON.stringify({id:42,login:"fixture-account"})); process.exit(0); }
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const parts = endpoint.split("/"), owner = decodeURIComponent(parts[1]), repo = decodeURIComponent(parts[2]);
  const action = args.includes("POST") ? "create_issue" : endpoint.includes("?") ? "list_issues" : "get_issue";
  const params = { owner, repo, ...(action === "create_issue" ? JSON.parse(input) : action === "get_issue" ? {issue_number:7} : {limit:1}) };
  const request = http.request({host:"127.0.0.1",port:${address.port},path:"/action",method:"POST",agent:false}, response => {
    let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => {
      const value = JSON.parse(text); process.stdout.write(JSON.stringify(action === "list_issues" ? value.issues : value));
    });
  });
  request.on("error", () => { process.exitCode = 1; }); request.end(JSON.stringify({ action, params }));
});
`,
      { mode: 0o700 },
    );
    chmodSync(executable, 0o700);
  }
  const execute = async (input: { action: string; params: Record<string, unknown> }) => {
    const response = await requestOnce(`http://127.0.0.1:${address.port}/action`, {
      method: "POST",
      body: JSON.stringify({ action: input.action, params: input.params }),
    });
    return response.json();
  };
  setDefaultCredentialAccess({
    listMasked: () => [credential],
    resolveMeta: () => credential,
    envExposures: () => ({}),
    resolveValue: async () => {
      resolutions++;
      throw new Error("Host custody must not expose a token");
    },
    executeRemoteLinkAction: execute,
    executeLocalOAuthLinkAction: execute,
  });
  const ledger = new OperationLedger(directory);
  const ctx = {
    cwd: directory,
    settingsScope: "isolated",
    sessionId: "fixture-session",
    originClientMessageId: "trusted-user-intent",
    askUser: async () => "允许执行",
    allowedToolNames: new Set(["LinkAction"]),
    operations: {
      controller: new OperationController(ledger),
      resolver: new CapabilityResolver(),
      sessionId: "fixture-session",
      runId: "trusted-run",
    },
  } as ToolContext;
  const invoke = async (
    options: {
      params?: Record<string, unknown>;
      rules?: PermissionRule[];
      hooks?: HookRegistry;
      ctx?: ToolContext;
    } = {},
  ) => {
    const executor = new ToolExecutor(
      new ToolRegistry({ builtinTools: ["LinkAction"] }),
      new PermissionClassifier(
        [...(options.rules ?? []), { tool: "LinkAction", decision: "allow" }],
        "default",
      ),
      options.hooks ?? new HookRegistry(),
    );
    executor.setContext(options.ctx ?? ctx);
    const result = await executor.executeSingle({
      id: `model-tool-${calls.length}`,
      toolName: "LinkAction",
      args: {
        provider: "github",
        action: "create_issue",
        connectionId: credential.id,
        params: options.params ?? {
          owner: "acme",
          repo: "test",
          title: "Synthetic issue",
          body: "Synthetic body",
        },
      },
    });
    return result.isError
      ? { kind: "executor_error", error: result.error }
      : JSON.parse(String(result.result));
  };
  return {
    calls,
    credential,
    ledger,
    ctx,
    invoke,
    setMatch: (value: boolean) => {
      match = value;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    revokeAfterValidate: () => {
      revokeAfterValidate = true;
    },
    resolutions: () => resolutions,
  };
}

test.each(["remote", "oauth"] as const)(
  "%s Host write crosses actual HTTP once and independently verifies through the owning executor",
  async (backend) => {
    const f = await fixture(backend);
    const result = await f.invoke();
    expect(result.kind).toBe("action_result");
    expect(result.operation.state).toBe("verified");
    expect(f.calls.map((call) => call.action)).toEqual([
      "list_issues",
      "create_issue",
      "get_issue",
    ]);
    expect(
      f.calls.every((call) => call.params.owner === "acme" && call.params.repo === "test"),
    ).toBe(true);
    expect((await f.invoke()).operation.id).toBe(result.operation.id);
    expect(f.calls).toHaveLength(3);
    expect(f.resolutions()).toBe(0);
  },
);

test.skipIf(process.platform === "win32")(
  "legacy managed CLI write grant is rejected before any transport",
  async () => {
    const f = await fixture("cli");
    const result = await f.invoke();
    expect(result.kind).toBe("error");
    expect(result.error).toContain("CLI write actions");
    expect(f.calls).toEqual([]);
    expect(f.resolutions()).toBe(0);
  },
);

test("actual lost POST response is unknown; different model tool ID, revised body, or later continue cannot replay", async () => {
  const f = await fixture();
  f.loseResponse();
  expect((await f.invoke()).operation.state).toBe("unknown");
  expect((await f.invoke()).operation.state).toBe("unknown");
  expect(
    (
      await f.invoke({
        params: { owner: "acme", repo: "test", title: "Synthetic issue.", body: "Synthetic body" },
      })
    ).kind,
  ).toBe("error");
  f.ctx.originClientMessageId = "later-continue";
  expect((await f.invoke()).operation.state).toBe("blocked");
  expect(f.calls.filter((call) => call.action === "create_issue")).toHaveLength(1);
  expect(f.ledger.hasUnverifiedWrites("fixture-session")).toBe(true);
});

test("independent read mismatch never verifies the write response", async () => {
  const f = await fixture();
  f.setMatch(false);
  const result = await f.invoke();
  expect(result.kind).toBe("unverified_write");
  expect(result.operation.state).toBe("succeeded");
  expect(result.operation.error).toBe("postcondition_failed");
  f.setMatch(true);
  expect((await f.invoke()).operation.state).toBe("verified");
  expect(f.calls.filter((call) => call.action === "create_issue")).toHaveLength(1);
});

test("exact argument read denial prevents the POST instead of borrowing outer write approval", async () => {
  const f = await fixture();
  const result = await f.invoke({
    rules: [{ tool: "LinkAction", argsPattern: { action: "get_issue" }, decision: "deny" }],
  });
  expect(result.operation.state).toBe("blocked");
  expect(f.calls).toHaveLength(0);
  expect(f.ledger.hasUnverifiedWrites("fixture-session")).toBe(false);
});

test("missing declared read grant and live capability revocation fail closed before POST", async () => {
  const first = await fixture();
  first.credential.meta!.linkCapabilityIds = ["github.create_issue"];
  expect((await first.invoke()).operation.state).toBe("blocked");
  expect(first.calls).toHaveLength(0);
  const second = await fixture();
  second.revokeAfterValidate();
  expect((await second.invoke()).kind).toBe("error"); // Revoked authority also suppresses the returned result.
  expect(second.calls.map((call) => call.action)).toEqual(["list_issues"]);
});

test("bound read hook cannot change the validated target; revocation after approval prevents all IO", async () => {
  const f = await fixture();
  const hooks = new HookRegistry();
  hooks.register("pre_tool_use", (event) => {
    if (event.data.args?.action === "list_issues")
      return { updatedInput: { ...event.data.args, params: { owner: "other", repo: "private" } } };
    return {};
  });
  expect((await f.invoke({ hooks })).operation.state).toBe("blocked");
  expect(f.calls).toHaveLength(0);
  const next = await fixture();
  next.ctx.askUser = async () => {
    next.credential.hasSecret = false;
    return "允许执行";
  };
  expect((await next.invoke()).kind).toBe("error");
  expect(next.calls).toHaveLength(0);
});

test("display-only post-hook context does not corrupt private verification evidence or skip hooks", async () => {
  const f = await fixture(),
    hooks = new HookRegistry();
  let observed = 0;
  hooks.register("post_tool_use", (event) => {
    if (event.data.toolName === "LinkAction") observed++;
    return { additionalContext: "Synthetic display-only hook context" };
  });
  // The outer displayed result is decorated too, so read just its first JSON line.
  const executor = new ToolExecutor(
    new ToolRegistry({ builtinTools: ["LinkAction"] }),
    new PermissionClassifier([{ tool: "LinkAction", decision: "allow" }], "default"),
    hooks,
  );
  executor.setContext(f.ctx);
  const output = await executor.executeSingle({
    id: "decorated-write",
    toolName: "LinkAction",
    args: {
      provider: "github",
      action: "create_issue",
      connectionId: f.credential.id,
      params: { owner: "acme", repo: "test", title: "Synthetic issue", body: "Synthetic body" },
    },
  });
  expect(output.isError).toBe(false);
  expect(JSON.parse(String(output.result).split("\n")[0]!).operation.state).toBe("verified");
  expect(output.result).toContain("Synthetic display-only hook context");
  expect(observed).toBe(3);
});
