import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asGlobalFetch } from "../testing/fetch-stub.js";
import { setDefaultCredentialAccess, type CredentialAccess } from "../credentials/access.js";
import type { ToolContext } from "../tool-system/context.js";
import { linkActionTool } from "./link-action-tool.js";
import { runCliLinkCommand } from "./cli.js";
import {
  getLocalLinkProvider,
  listLocalLinkProviders,
  validateLocalLinkToken,
} from "./providers.js";

const cwd = "/repo";

function context(askUser?: ToolContext["askUser"]): ToolContext {
  return { cwd, askUser, signal: new AbortController().signal } as unknown as ToolContext;
}

interface GithubState {
  connected: boolean;
  resolveCalls: number;
  listeners?: Set<() => void>;
}

function githubAccess(
  state: GithubState,
  backend: "http-token" | "cli" = "http-token",
): CredentialAccess {
  const credential = {
    id: "link-github-fine-grained-pat",
    type: "link" as const,
    label: "GitHub local",
    hasSecret: true,
    meta: {
      linkProvider: "github",
      linkConnectionMethod: "fine-grained-pat",
      linkExecutionRuntime: "local" as const,
      linkExecutionBackend: backend,
      agentExposable: false,
      linkAccountId: "42",
      linkAccountLabel: "octocat",
      linkLastVerifiedAt: "2026-08-02T00:00:00.000Z",
    },
  };
  return {
    listMasked: () => (state.connected ? [credential] : []),
    resolveMeta: () => (state.connected ? credential : undefined),
    envExposures: () => ({}),
    subscribe: (listener) => {
      (state.listeners ??= new Set()).add(listener);
      return () => state.listeners?.delete(listener);
    },
    resolveValue: async () => {
      state.resolveCalls += 1;
      if (!state.connected) throw new Error("credential disconnected");
      return "github_pat_private";
    },
  };
}

afterEach(() => {
  setDefaultCredentialAccess(null);
  delete process.env.CODESHELL_CLI_LINK_HANG;
  delete process.env.CODESHELL_CLI_LINK_MARKER;
});

function installFakeGithubCli(directory: string): void {
  const command = join(directory, "gh");
  writeFileSync(
    command,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const args = process.argv.slice(2);\n` +
      `const endpoint = args[1] || "";\n` +
      `if (endpoint === "user") { process.stdout.write(JSON.stringify({ id: 42, login: "octocat" })); process.exit(0); }\n` +
      `if (process.env.CODESHELL_CLI_LINK_HANG === "1") { fs.writeFileSync(process.env.CODESHELL_CLI_LINK_MARKER, "started"); setInterval(() => {}, 1000); }\n` +
      `else { process.stdout.write(JSON.stringify([{ id: 1, full_name: "acme/repo" }])); }\n`,
  );
  chmodSync(command, 0o755);
}

describe("local Link providers", () => {
  test("registers ten unique local-first providers with actions", () => {
    const providers = listLocalLinkProviders();
    expect(providers).toHaveLength(10);
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(10);
    expect(providers.map((provider) => provider.id)).toEqual([
      "github",
      "gitlab",
      "figma",
      "notion",
      "linear",
      "slack",
      "sentry",
      "airtable",
      "todoist",
      "vercel",
    ]);
    expect(providers.every((provider) => provider.actions.length >= 2)).toBe(true);
  });

  test("validates GitHub through the real endpoint contract without returning the token", async () => {
    let authorization = "";
    const validation = await validateLocalLinkToken("github", " github_pat_private ", {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        if (String(url).startsWith("https://api.github.com/user/repos?")) {
          return new Response(
            JSON.stringify([
              { id: 1, full_name: "octocat/hello-world" },
              { id: 2, full_name: "acme/private-repo" },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        expect(String(url)).toBe("https://api.github.com/user");
        return new Response(JSON.stringify({ id: 42, login: "octocat", name: "Octo Cat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(authorization).toBe("Bearer github_pat_private");
    expect(validation.identity).toMatchObject({ externalAccountId: "42", label: "octocat" });
    expect(validation.identity.resourceLabels).toEqual([
      "octocat/hello-world",
      "acme/private-repo",
    ]);
    expect(JSON.stringify(validation)).not.toContain("github_pat_private");
    expect(validation.capabilityIds).toContain("github.list_repositories");
    expect(validation.capabilityIds).toContain("github.get_file");
    expect(validation.capabilityIds).toContain("github.get_issue");
    expect(validation.capabilityIds).toContain("github.get_pull_request");
  });

  test("pins documented GitHub and Notion API versions", async () => {
    let githubVersion = "";
    await validateLocalLinkToken("github", "github_pat_private", {
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        githubVersion = new Headers(init?.headers).get("x-github-api-version") ?? "";
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch,
    });
    expect(githubVersion).toBe("2022-11-28");

    let notionVersion = "";
    await executeProviderAction("notion", "get_page", { page_id: "page-1" }, (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      notionVersion = new Headers(init?.headers).get("notion-version") ?? "";
      return new Response(JSON.stringify({ object: "page", id: "page-1" }), { status: 200 });
    }) as typeof fetch);
    expect(notionVersion).toBe("2022-06-28");
  });
});

function executeProviderAction(
  providerId: string,
  actionId: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const provider = getLocalLinkProvider(providerId);
  const action = provider?.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`missing action ${providerId}.${actionId}`);
  return action.execute({ token: "test-token", params, fetchImpl });
}

function recordingFetch(makeResponse: () => Response): { urls: string[]; fetchImpl: typeof fetch } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return makeResponse();
  }) as typeof fetch;
  return { urls, fetchImpl };
}

describe("path template hardening", () => {
  test("rejects a dot-segment Sentry organization without sending any request", async () => {
    const { urls, fetchImpl } = recordingFetch(() => new Response("[]", { status: 200 }));
    let error: unknown;
    try {
      await executeProviderAction("sentry", "list_projects", { organization: ".." }, fetchImpl);
    } catch (caught) {
      error = caught;
    }
    // The fixed path template must stay fixed: no request may leave the process.
    expect(urls).toEqual([]);
    expect(String(error)).toContain("organization");
  });

  test("rejects dot segments and separators in every single-segment path param", async () => {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ["github", "list_issues", { owner: "..", repo: "repo" }, "owner"],
      ["github", "list_issues", { owner: "acme", repo: "repo/../../user" }, "repo"],
      ["github", "get_readme", { owner: ".", repo: "repo" }, "owner"],
      ["notion", "get_page", { page_id: "../users/me" }, "page_id"],
      ["airtable", "list_tables", { base_id: ".." }, "base_id"],
      ["figma", "get_file", { file_key: ".." }, "file_url_or_key"],
    ];
    for (const [providerId, actionId, params, paramName] of cases) {
      const { urls, fetchImpl } = recordingFetch(() => new Response("{}", { status: 200 }));
      let error: unknown;
      try {
        await executeProviderAction(providerId, actionId, params, fetchImpl);
      } catch (caught) {
        error = caught;
      }
      expect(urls).toEqual([]);
      expect(String(error)).toContain(paramName);
    }
  });

  test("rejects traversal in the multi-segment GitHub file path without fetching", async () => {
    for (const path of ["docs/../secret", "..", "docs//secret", "%2e%2e/secret"]) {
      const { urls, fetchImpl } = recordingFetch(() => new Response("{}", { status: 200 }));
      let error: unknown;
      try {
        await executeProviderAction(
          "github",
          "get_file",
          { owner: "o", repo: "r", path },
          fetchImpl,
        );
      } catch (caught) {
        error = caught;
      }
      expect(urls).toEqual([]);
      expect(String(error)).toContain("path");
    }
  });

  test("still reads a legitimate nested GitHub file path", async () => {
    const { urls, fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "file",
            path: "docs/a/b.md",
            sha: "abc",
            size: 5,
            content: Buffer.from("hello").toString("base64"),
          }),
          { status: 200 },
        ),
    );
    const result = (await executeProviderAction(
      "github",
      "get_file",
      { owner: "o", repo: "r", path: "docs/a/b.md" },
      fetchImpl,
    )) as Record<string, unknown>;
    expect(urls).toEqual(["https://api.github.com/repos/o/r/contents/docs/a/b.md"]);
    expect(result.content).toBe("hello");
  });
});

describe("LinkAction tool", () => {
  test("lists only connected providers and never exposes the raw token", async () => {
    const state = { connected: true, resolveCalls: 0 };
    setDefaultCredentialAccess(githubAccess(state));
    const result = await linkActionTool({}, context());
    expect(JSON.parse(result)).toMatchObject({
      kind: "connected_providers",
      providers: [{ id: "github", account: "octocat" }],
    });
    expect(result).not.toContain("github_pat_private");
    expect(state.resolveCalls).toBe(0);
  });

  test("does not offer an expired browser OAuth connection", async () => {
    const state = { connected: true, resolveCalls: 0 };
    const access = githubAccess(state);
    const credential = access.listMasked(cwd, "full")[0]!;
    access.listMasked = () => [
      {
        ...credential,
        oauthStatus: {
          state: "expired",
          accessTokenExpiresAt: "2026-08-01T00:00:00.000Z",
          hasRefreshToken: true,
        },
      },
    ];
    setDefaultCredentialAccess(access);

    expect(JSON.parse(await linkActionTool({}, context()))).toMatchObject({
      kind: "connected_providers",
      providers: [],
    });
    expect(state.resolveCalls).toBe(0);
  });

  test("resolves the credential live and fails immediately after disconnect", async () => {
    const state = { connected: true, resolveCalls: 0 };
    setDefaultCredentialAccess(githubAccess(state));
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = asGlobalFetch(async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify([{ id: 1, full_name: "acme/repo" }]), { status: 200 });
    });
    try {
      const connected = JSON.parse(
        await linkActionTool(
          { provider: "github", action: "list_repositories", params: { limit: 10 } },
          context(),
        ),
      );
      expect(connected).toMatchObject({
        kind: "action_result",
        provider: "github",
        runtime: "local",
      });
      expect(state.resolveCalls).toBe(1);
      expect(fetchCalls).toBe(1);

      state.connected = false;
      const disconnected = JSON.parse(
        await linkActionTool(
          { provider: "github", action: "list_repositories", params: {} },
          context(),
        ),
      );
      expect(disconnected.kind).toBe("error");
      expect(disconnected.error).toContain("not connected locally");
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("requires a closed user approval before creating a GitHub issue", async () => {
    const state = { connected: true, resolveCalls: 0 };
    setDefaultCredentialAccess(githubAccess(state));
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = asGlobalFetch(async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ number: 7, title: "Bug", state: "open" }), {
        status: 201,
      });
    });
    try {
      const cancelled = JSON.parse(
        await linkActionTool(
          {
            provider: "github",
            action: "create_issue",
            params: { owner: "acme", repo: "repo", title: "Bug" },
          },
          context(async (_question, options) => {
            expect(options?.optionsOnly).toBe(true);
            return "取消";
          }),
        ),
      );
      expect(cancelled.kind).toBe("cancelled");
      expect(state.resolveCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("aborts an in-flight provider request when the desktop credential snapshot disconnects", async () => {
    const state: GithubState = { connected: true, resolveCalls: 0 };
    setDefaultCredentialAccess(githubAccess(state));
    const previousFetch = globalThis.fetch;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      requestStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Link connection disconnected", "AbortError")),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;
    try {
      const pending = linkActionTool(
        { provider: "github", action: "list_repositories", params: {} },
        context(),
      );
      await started;
      state.connected = false;
      for (const listener of state.listeners ?? []) listener();
      const result = JSON.parse(await pending);
      expect(result.kind).toBe("error");
      expect(result.error).toContain("disconnected");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("runs a CLI connection without resolving a token and kills it on disconnect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codeshell-link-cli-"));
    const marker = join(directory, "started");
    const previousPath = process.env.PATH;
    installFakeGithubCli(directory);
    process.env.PATH = `${directory}:${previousPath ?? ""}`;
    const state: GithubState = { connected: true, resolveCalls: 0 };
    setDefaultCredentialAccess(githubAccess(state, "cli"));
    const cliContext = { ...context(), cwd: directory } as ToolContext;
    try {
      const probe = await runCliLinkCommand(
        "github",
        "gh",
        ["api", "user", "--hostname", "github.com"],
        { timeoutMs: 5_000 },
      );
      expect(JSON.parse(probe.stdout)).toEqual({ id: 42, login: "octocat" });
      const connected = JSON.parse(
        await linkActionTool(
          { provider: "github", action: "list_repositories", params: { limit: 10 } },
          cliContext,
        ),
      );
      expect(connected).toMatchObject({
        kind: "action_result",
        provider: "github",
        data: { repositories: [{ full_name: "acme/repo" }] },
      });
      expect(state.resolveCalls).toBe(0);

      process.env.CODESHELL_CLI_LINK_HANG = "1";
      process.env.CODESHELL_CLI_LINK_MARKER = marker;
      const pending = linkActionTool(
        { provider: "github", action: "list_repositories", params: {} },
        cliContext,
      );
      for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(true);
      state.connected = false;
      for (const listener of state.listeners ?? []) listener();
      const disconnected = JSON.parse(await pending);
      expect(disconnected.kind).toBe("error");
      expect(disconnected.error).toMatch(/abort|disconnect/i);
      expect(state.resolveCalls).toBe(0);

      const next = JSON.parse(
        await linkActionTool(
          { provider: "github", action: "list_repositories", params: {} },
          cliContext,
        ),
      );
      expect(next.error).toContain("not connected locally");
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
