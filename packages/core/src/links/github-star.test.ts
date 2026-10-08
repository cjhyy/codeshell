import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultCredentialAccess, type CredentialMetadata } from "../credentials/access.js";
import { OperationLedger } from "../operations/ledger.js";
import { OperationController } from "../operations/controller.js";
import { CapabilityResolver } from "../operations/resolver.js";
import type { ToolContext } from "../tool-system/context.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import { getLocalLinkProvider } from "./providers.js";
import { executeCliLinkAction } from "./cli.js";
import { prepareRemoteLinkAction, normalizeRemoteLinkActionResult } from "./remote-adapters.js";
import { githubSetStarredParameters } from "./github-star.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  setDefaultCredentialAccess(null);
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const caps = ["github.get_repository", "github.get_starred", "github.set_starred"];
function fixture(backend: "remote" | "oauth" = "remote") {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-star-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const credential: CredentialMetadata = {
    id: "connection",
    type: backend === "remote" ? "oauth" : "link",
    label: "Fixture",
    hasSecret: true,
    oauthStatus: { state: "valid", canRefresh: true },
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: backend === "remote" ? "server" : "local",
      linkExecutionBackend: backend === "remote" ? "remote" : "http-token",
      linkAccountId: "42",
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      ...(backend === "remote"
        ? { linkRemoteState: "connected", linkRemoteGrantId: "grant" }
        : { linkAuthSource: "browser-oauth", linkOAuthState: "connected" }),
      linkCapabilityIds: [...caps],
    },
  };
  let starred = false,
    lose = false,
    mismatch = false,
    wrongTarget = false,
    revoke = false;
  const calls: string[] = [];
  const execute = async ({
    action,
    params,
  }: {
    action: string;
    params: Record<string, unknown>;
  }) => {
    calls.push(action);
    if (action === "get_repository")
      return { id: 123, full_name: wrongTarget ? "other/repo" : "acme/repo" };
    if (action === "get_starred") {
      if (revoke) credential.meta!.linkCapabilityIds = ["github.set_starred"];
      return { starred: mismatch && calls.includes("set_starred") ? !starred : starred };
    }
    if (action === "set_starred") {
      starred = params.starred as boolean;
      if (lose) throw new Error("Lost response");
      return { acknowledged: true };
    }
    throw new Error("Unexpected fixture action");
  };
  setDefaultCredentialAccess({
    listMasked: () => [credential],
    resolveMeta: () => credential,
    envExposures: () => ({}),
    executeRemoteLinkAction: execute,
    executeLocalOAuthLinkAction: execute,
  });
  const ledger = new OperationLedger(directory);
  const ctx = {
    cwd: directory,
    settingsScope: "isolated",
    originClientMessageId: "intent",
    sessionId: "session",
    askUser: async () => "允许执行",
    operations: {
      sessionId: "session",
      runId: "run",
      controller: new OperationController(ledger),
      resolver: new CapabilityResolver(),
    },
  } as ToolContext;
  const invoke = async (
    params: Record<string, unknown> = { owner: "Acme", repo: "Repo", starred: true },
    options: { deny?: string; hooks?: HookRegistry; action?: string } = {},
  ) => {
    const executor = new ToolExecutor(
      new ToolRegistry({ builtinTools: ["LinkAction"] }),
      new PermissionClassifier(
        [
          ...(options.deny
            ? [
                {
                  tool: "LinkAction",
                  decision: "deny" as const,
                  argsPattern: { action: options.deny },
                },
              ]
            : []),
          { tool: "LinkAction", decision: "allow" },
        ],
        "default",
      ),
      options.hooks ?? new HookRegistry(),
    );
    executor.setContext(ctx);
    const result = await executor.executeSingle({
      id: `tool-${calls.length}`,
      toolName: "LinkAction",
      args: {
        provider: "github",
        action: options.action ?? "set_starred",
        connectionId: credential.id,
        params,
      },
    });
    return result.isError
      ? { kind: "executor_error" }
      : JSON.parse(String(result.result).split("\n")[0]!);
  };
  return {
    credential,
    calls,
    ctx,
    ledger,
    invoke,
    setStarred: (v: boolean) => {
      starred = v;
    },
    lose: () => {
      lose = true;
    },
    mismatch: () => {
      mismatch = true;
    },
    wrongTarget: () => {
      wrongTarget = true;
    },
    revoke: () => {
      revoke = true;
    },
  };
}

test.each(["remote", "oauth"] as const)(
  "%s fixed Star write validates identity, reads state and independently verifies",
  async (backend) => {
    const f = fixture(backend);
    const output = await f.invoke();
    expect(output.kind).toBe("action_result");
    expect(output.data).toEqual({
      owner: "acme",
      repo: "repo",
      starred: true,
      changed: true,
      verified: true,
    });
    expect(f.calls).toEqual(["get_repository", "get_starred", "set_starred", "get_starred"]);
    expect((await f.invoke()).operation.id).toBe(output.operation.id);
    expect(f.calls).toHaveLength(4);
    expect((await f.invoke({ owner: "acme", repo: "other", starred: true })).kind).toBe("error");
    expect((await f.invoke({ owner: "acme", repo: "repo", starred: false })).kind).toBe("error");
  },
);

test.each([true, false])(
  "already desired %s is a verified no-op with another independent GET",
  async (desired) => {
    const f = fixture();
    f.setStarred(desired);
    const output = await f.invoke({ owner: "acme", repo: "repo", starred: desired });
    expect(output.operation.state).toBe("verified");
    expect(output.data.changed).toBe(false);
    expect(f.calls).toEqual(["get_repository", "get_starred", "get_starred"]);
  },
);

test("Unstar uses the same verified controller with false desired state", async () => {
  const f = fixture();
  f.setStarred(true);
  const output = await f.invoke({ owner: "acme", repo: "repo", starred: false });
  expect(output.data.starred).toBe(false);
  expect(output.data.changed).toBe(true);
  expect(output.operation.state).toBe("verified");
});

test("lost write result never replays across tool IDs, changed target, trusted continue or a restarted ledger", async () => {
  const f = fixture();
  f.lose();
  expect((await f.invoke()).operation.state).toBe("unknown");
  f.ctx.operations!.controller = new OperationController(new OperationLedger(f.ctx.cwd!));
  expect((await f.invoke()).operation.state).toBe("unknown");
  expect((await f.invoke({ owner: "other", repo: "repo", starred: true })).kind).toBe("error");
  f.ctx.originClientMessageId = "continue";
  expect((await f.invoke()).operation.state).toBe("blocked");
  expect(f.calls.filter((x) => x === "set_starred")).toHaveLength(1);
});

test("wrong repository, denied reads, missing grants and post-read revocation stop before write", async () => {
  const f = fixture();
  f.wrongTarget();
  expect((await f.invoke()).operation.state).toBe("blocked");
  expect(f.calls).toEqual(["get_repository"]);
  const denied = fixture();
  expect((await denied.invoke(undefined, { deny: "get_starred" })).operation.state).toBe("blocked");
  expect(denied.calls).toEqual([]);
  const missing = fixture();
  missing.credential.meta!.linkCapabilityIds = ["github.set_starred"];
  expect((await missing.invoke()).operation.state).toBe("blocked");
  expect(missing.calls).toEqual([]);
  const revoked = fixture();
  revoked.revoke();
  expect((await revoked.invoke()).kind).toBe("error");
  expect(revoked.calls).toEqual(["get_repository", "get_starred"]);
});

test("legacy absent or empty grants never acquire new Star capabilities", async () => {
  for (const ids of [undefined, []]) {
    const f = fixture("oauth");
    f.credential.meta!.linkCapabilityIds = ids;
    expect((await f.invoke()).kind).toBe("error");
    expect(f.calls).toEqual([]);
  }
});

test("read hook target mutation fails closed; display hook leaves private verify receipt intact", async () => {
  const f = fixture(),
    hooks = new HookRegistry();
  hooks.register("pre_tool_use", (event) =>
    event.data.args?.action === "get_starred"
      ? { updatedInput: { ...event.data.args, params: { owner: "other", repo: "repo" } } }
      : {},
  );
  expect((await f.invoke(undefined, { hooks })).operation.state).toBe("blocked");
  expect(f.calls).toEqual(["get_repository"]);
  const next = fixture(),
    display = new HookRegistry();
  let observed = 0;
  display.register("post_tool_use", () => {
    observed++;
    return { additionalContext: "Fixture display" };
  });
  expect((await next.invoke(undefined, { hooks: display })).operation.state).toBe("verified");
  expect(observed).toBe(4);
});

test("write acknowledgement cannot replace independent matching read", async () => {
  const f = fixture();
  f.mismatch();
  const output = await f.invoke();
  expect(output.kind).toBe("unverified_write");
  expect(output.operation.state).toBe("succeeded");
  expect(output.data.verified).toBe(false);
});

test.each(["token", "oauth"] as const)(
  "%s provider accepts empty 204 and plain-text 404; fixed PUT/DELETE has no body",
  async (authKind) => {
    const provider = getLocalLinkProvider("github")!;
    let status = 404;
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      calls.push(init);
      return new Response(status === 204 ? null : "not starred", { status });
    }) as typeof fetch;
    const ctx = {
      token: "synthetic",
      authKind,
      params: { owner: "acme", repo: "repo" },
      fetchImpl,
    };
    expect(await provider.actions.find((a) => a.id === "get_starred")!.execute(ctx)).toEqual({
      starred: false,
    });
    status = 204;
    expect(await provider.actions.find((a) => a.id === "get_starred")!.execute(ctx)).toEqual({
      starred: true,
    });
    for (const starred of [true, false])
      expect(
        await provider.actions
          .find((a) => a.id === "set_starred")!
          .execute({ ...ctx, params: { ...ctx.params, starred } }),
      ).toEqual({ acknowledged: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PUT", "DELETE"]);
    expect(calls.every((c) => c.redirect === "error")).toBe(true);
    expect(calls[2]!.body).toBeUndefined();
    expect(calls[2]!.headers).toMatchObject({ "Content-Length": "0" });
    status = 404;
    await expect(
      provider.actions
        .find((a) => a.id === "set_starred")!
        .execute({ ...ctx, params: { ...ctx.params, starred: true } }),
    ).rejects.toThrow("HTTP 404");
  },
);

test("managed CLI status parsing accepts real gh empty responses and 404 exit only", async () => {
  const params = { owner: "acme", repo: "repo" };
  const calls: string[][] = [];
  const run = async (_provider: unknown, _cmd: unknown, args: string[]) => {
    calls.push(args);
    return { stdout: "HTTP/2.0 204 No Content\r\n\r\n", stderr: "" };
  };
  expect(await executeCliLinkAction("github", "get_starred", params, {}, run)).toEqual({
    starred: true,
  });
  for (const starred of [true, false])
    expect(
      await executeCliLinkAction("github", "set_starred", { ...params, starred }, {}, run),
    ).toEqual({ acknowledged: true });
  expect(calls.map((x) => x[x.indexOf("--method") + 1])).toEqual(["GET", "PUT", "DELETE"]);
  const notStarred = async () => {
    throw Object.assign(new Error("HTTP 404"), {
      code: 1,
      stdout: "HTTP/2.0 404 Not Found\r\n\r\n",
      stderr: "gh: Not Found (HTTP 404)",
    });
  };
  expect(await executeCliLinkAction("github", "get_starred", params, {}, notStarred)).toEqual({
    starred: false,
  });
  await expect(
    executeCliLinkAction("github", "set_starred", { ...params, starred: true }, {}, notStarred),
  ).rejects.toThrow();
  await expect(
    executeCliLinkAction("github", "get_starred", params, {}, async () => {
      throw new Error("404");
    }),
  ).rejects.toThrow();
});

test("remote adapter keeps selected repositories, strict boolean and bounded fixed result", () => {
  const groups = [{ id: "repositories", items: [{ id: "acme/repo", label: "acme/repo" }] }];
  expect(
    prepareRemoteLinkAction(
      "github",
      "set_starred",
      { owner: "acme", repo: "repo", starred: false },
      groups,
    ),
  ).toEqual({ owner: "acme", repo: "repo", starred: false });
  expect(() =>
    prepareRemoteLinkAction(
      "github",
      "set_starred",
      { owner: "other", repo: "repo", starred: true },
      groups,
    ),
  ).toThrow();
  expect(() =>
    githubSetStarredParameters({ owner: "acme", repo: "repo", starred: "true" }),
  ).toThrow();
  expect(() =>
    githubSetStarredParameters({ owner: "acme", repo: "repo", starred: true, method: "POST" }),
  ).toThrow();
  expect(
    normalizeRemoteLinkActionResult("github", "get_starred", { starred: false }, {}, groups),
  ).toEqual({ starred: false });
});
