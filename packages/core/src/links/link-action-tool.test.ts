import { afterEach, describe, expect, test } from "bun:test";
import { asGlobalFetch } from "../testing/fetch-stub.js";
import { setDefaultCredentialAccess, type CredentialAccess } from "../credentials/access.js";
import type { ToolContext } from "../tool-system/context.js";
import { linkActionTool } from "./link-action-tool.js";
import { listLocalLinkProviders, validateLocalLinkToken } from "./providers.js";

const cwd = "/repo";

function context(askUser?: ToolContext["askUser"]): ToolContext {
  return { cwd, askUser, signal: new AbortController().signal } as unknown as ToolContext;
}

interface GithubState {
  connected: boolean;
  resolveCalls: number;
  listeners?: Set<() => void>;
}

function githubAccess(state: GithubState): CredentialAccess {
  const credential = {
    id: "link-github-fine-grained-pat",
    type: "link" as const,
    label: "GitHub local",
    hasSecret: true,
    meta: {
      linkProvider: "github",
      linkConnectionMethod: "fine-grained-pat",
      linkExecutionRuntime: "local" as const,
      agentExposable: false,
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

afterEach(() => setDefaultCredentialAccess(null));

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
        expect(String(url)).toBe("https://api.github.com/user");
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ id: 42, login: "octocat", name: "Octo Cat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(authorization).toBe("Bearer github_pat_private");
    expect(validation.identity).toMatchObject({ externalAccountId: "42", label: "octocat" });
    expect(JSON.stringify(validation)).not.toContain("github_pat_private");
    expect(validation.capabilityIds).toContain("github.list_repositories");
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
});
