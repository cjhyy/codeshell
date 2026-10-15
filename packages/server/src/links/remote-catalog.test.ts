import { expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  readRemoteProviderCatalog,
  readRemoteProviderCapabilities,
  REMOTE_LINK_ADAPTERS,
  RemoteLinkCatalogError,
} from "./remote-catalog.js";

function github() {
  const adapter = REMOTE_LINK_ADAPTERS[0];
  return {
    id: adapter.id,
    methods: [
      {
        id: "remote-link",
        authKind: "oauth",
        defaultAuthModeId: "browser",
        authModes: [{ id: "browser", kind: "redirect" }],
      },
    ],
    scopes: [...adapter.scopes],
    actions: [...adapter.actions] as string[],
  };
}

async function catalog(body: unknown, status = 200, capabilities = false) {
  const requests: string[] = [];
  const accepted: unknown[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    accepted.push(JSON.parse(String(request.headers["x-codeshell-link-capabilities"])));
    response.writeHead(status, {
      "Content-Type": "application/json",
      ...(status === 302 ? { Location: "https://example.invalid/untrusted" } : {}),
    });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const original = globalThis.fetch;
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/links/providers`;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe(endpoint);
    expect(init?.redirect).toBe("error");
    return original(input, init);
  }) as typeof fetch;
  try {
    return await (capabilities ? readRemoteProviderCapabilities : readRemoteProviderCatalog)({
      issuer: `http://127.0.0.1:${address.port}`,
      clientId: "catalog-test",
      redirectUri: "http://127.0.0.1:9876/callback",
    });
  } finally {
    globalThis.fetch = original;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    expect(requests).toEqual(["/api/v1/links/providers"]);
    expect(accepted).toEqual([
      { version: 1, scopes: REMOTE_LINK_ADAPTERS.flatMap((adapter) => adapter.scopes) },
    ]);
  }
}

test("remote catalog advertises only reviewed executable providers", async () => {
  expect(
    await catalog({ version: 1, providers: [github(), { ...github(), id: "untrusted" }] }),
  ).toEqual(["github"]);
  expect(await catalog({ version: 1, providers: [] })).toEqual([]);
});

test("remote catalog cannot expand actions or change the authorization mechanism", async () => {
  const expanded = github();
  expanded.actions.push("write_issue");
  await expect(catalog({ version: 1, providers: [expanded] })).rejects.toMatchObject({
    name: "RemoteLinkCatalogError",
    code: "invalid_response",
    reason: "unreviewed_capability",
  });
  const changed = github();
  changed.methods[0]!.authModes[0]!.kind = "qr-code";
  await expect(catalog({ version: 1, providers: [changed] })).rejects.toMatchObject({
    code: "invalid_response",
    reason: "unsupported_auth",
  });
});

test("ambiguous supported authorization methods or modes cannot be silently selected", async () => {
  for (const duplicate of ["method", "mode"]) {
    const provider = github();
    if (duplicate === "method") provider.methods.push(structuredClone(provider.methods[0]!));
    else provider.methods[0]!.authModes.push({ id: "browser", kind: "redirect" });
    await expect(catalog({ version: 1, providers: [provider] })).rejects.toMatchObject({
      code: "invalid_response",
      reason: "unsupported_auth",
    });
  }
});

test("ambiguous and malformed remote catalogs fail closed", async () => {
  for (const value of [
    { version: 1, providers: [github(), github()] },
    { version: 2, providers: [github()] },
    { version: 1, providers: [null] },
    { version: 1, providers: "not an array" },
  ])
    await expect(catalog(value)).rejects.toMatchObject({
      code: "invalid_response",
      reason: "invalid_schema",
    });
  await expect(catalog("not JSON upstream-private-secret")).rejects.toMatchObject({
    code: "invalid_response",
    reason: "invalid_json",
  });
  await expect(catalog(" ".repeat(32_769))).rejects.toMatchObject({ code: "response_too_large" });
});

test("HTTP failures retain their status without claiming any providers or reflecting error bodies", async () => {
  for (const status of [400, 404, 500, 501]) {
    try {
      await catalog("upstream-private-secret", status);
      throw new Error("expected catalog failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteLinkCatalogError);
      expect(error).toMatchObject({
        code: "http_error",
        reason: "http_status",
        httpStatus: status,
      });
      expect(String(error)).not.toContain("upstream-private-secret");
      expect(JSON.stringify(error)).not.toContain("upstream-private-secret");
    }
  }
});

test("remote catalog never follows redirects to an untrusted source", async () => {
  await expect(catalog({}, 302)).rejects.toMatchObject({ code: "network_error" });
});

function allProviders() {
  return REMOTE_LINK_ADAPTERS.map((adapter) => ({
    ...github(),
    id: adapter.id,
    actions: [...adapter.actions],
    scopes: [...adapter.scopes],
  }));
}

test("all ten reviewed providers retain their own declared action/scope intersection", async () => {
  const providers = allProviders();
  expect(providers.flatMap((provider) => provider.actions)).toHaveLength(38);
  expect(providers.find((provider) => provider.id === "figma")?.actions).toEqual([
    "get_file",
    "get_comments",
    "get_nodes",
    "get_images",
    "get_image_fills",
  ]);
  expect(await catalog({ version: 1, providers }, 200, true)).toEqual(
    REMOTE_LINK_ADAPTERS.map(({ id, actions, scopes }) => ({ id, actions: [...actions], scopes })),
  );
  const selected = providers[1]!;
  selected.actions = selected.actions.slice(0, 1);
  selected.scopes = selected.scopes.slice(0, 1);
  expect(await catalog({ version: 1, providers: [selected] }, 200, true)).toEqual([
    { id: "gitlab", actions: ["list_projects"], scopes: ["gitlab:list_projects"] },
  ]);
});

test("source evidence capabilities require each provider's exact reviewed action scopes", async () => {
  for (const [id, actions] of [
    ["github", ["list_pull_request_files", "list_pull_request_commits", "get_commit"]],
    ["slack", ["get_message", "get_thread"]],
  ] as const) {
    const scopes = actions.map((action) => `${id}:${action}`);
    const provider = { ...github(), id, actions: [...actions], scopes };
    expect(await catalog({ version: 1, providers: [provider] }, 200, true)).toEqual([
      { id, actions: [...actions], scopes },
    ]);
    for (const omitted of scopes) {
      const unrelatedScope = `${id}:${id === "github" ? "list_repositories" : "list_channels"}`;
      for (const invalidScopes of [
        scopes.filter((scope) => scope !== omitted),
        scopes.map((scope) => (scope === omitted ? unrelatedScope : scope)),
      ]) {
        await expect(
          catalog({ version: 1, providers: [{ ...provider, scopes: invalidScopes }] }, 200, true),
        ).rejects.toMatchObject({ code: "invalid_response", reason: "unreviewed_capability" });
      }
    }
    const otherProvider = id === "github" ? "slack" : "github";
    await expect(
      catalog(
        {
          version: 1,
          providers: [
            { ...provider, scopes: actions.map((action) => `${otherProvider}:${action}`) },
          ],
        },
        200,
        true,
      ),
    ).rejects.toMatchObject({ code: "invalid_response", reason: "unreviewed_capability" });
  }
});

test("issue state capabilities require their matching explicit catalog scopes", async () => {
  const provider = {
    ...github(),
    actions: ["get_repository", "get_issue", "update_issue"],
    scopes: ["github:get_repository", "github:get_issue", "github:update_issue"],
  };
  expect(await catalog({ version: 1, providers: [provider] }, 200, true)).toEqual([
    {
      id: "github",
      actions: ["get_repository", "get_issue", "update_issue"],
      scopes: ["github:get_repository", "github:get_issue", "github:update_issue"],
    },
  ]);
  for (const scopes of [
    ["github:get_repository", "github:get_issue"],
    ["github:get_repository", "github:get_issue", "github:create_issue"],
  ]) {
    await expect(
      catalog({ version: 1, providers: [{ ...provider, scopes }] }, 200, true),
    ).rejects.toMatchObject({ code: "invalid_response" });
  }
});

test("provider catalogs cannot borrow another provider's action scopes or hide extra authority", async () => {
  const provider = allProviders()[1]!;
  for (const scopes of [
    ["github:list_projects", "gitlab:list_issues"],
    [...provider.scopes, "gitlab:create_issue"],
    ["gitlab:list_projects", "gitlab:list_projects"],
  ]) {
    await expect(
      catalog({ version: 1, providers: [{ ...provider, scopes }] }, 200, true),
    ).rejects.toMatchObject({ code: "invalid_response" });
  }
  await expect(catalog({}, 404, true)).rejects.toMatchObject({
    code: "http_error",
    httpStatus: 404,
  });
});

test("a failed body stream preserves a safe network reason", async () => {
  const original = globalThis.fetch;
  let output!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://catalog.example/api/v1/links/providers");
    expect(init?.redirect).toBe("error");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller;
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const pending = readRemoteProviderCapabilities({
      issuer: "https://catalog.example",
      clientId: "fixture",
      redirectUri: "http://127.0.0.1:9876/callback",
    });
    await Promise.resolve();
    output.error(new Error("upstream-private-secret"));
    await expect(pending).rejects.toMatchObject({ code: "network_error", reason: "network" });
  } finally {
    globalThis.fetch = original;
  }
});

test("oversize streaming discovery cancels upstream without returning a partial catalog", async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (async (input) => {
    expect(String(input)).toBe("https://catalog.example/api/v1/links/providers");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(32_769));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  }) as typeof fetch;
  try {
    await expect(
      readRemoteProviderCapabilities({
        issuer: "https://catalog.example",
        clientId: "fixture",
        redirectUri: "http://127.0.0.1:9876/callback",
      }),
    ).rejects.toMatchObject({ code: "response_too_large", reason: "response_limit" });
    expect(cancelled).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("network and timeout failures never expose raw causes", async () => {
  const original = globalThis.fetch;
  try {
    for (const [name, reason] of [
      ["TypeError", "network"],
      ["TimeoutError", "timeout"],
    ]) {
      globalThis.fetch = (async (input) => {
        expect(String(input)).toBe("https://catalog.example/api/v1/links/providers");
        const error = new Error("upstream-private-secret");
        error.name = name!;
        throw error;
      }) as typeof fetch;
      try {
        await readRemoteProviderCapabilities({
          issuer: "https://catalog.example",
          clientId: "fixture",
          redirectUri: "http://127.0.0.1:9876/callback",
        });
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toMatchObject({
          name: "RemoteLinkCatalogError",
          code: "network_error",
          reason,
        });
        expect(String(error)).not.toContain("upstream-private-secret");
        expect(error).not.toHaveProperty("cause");
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});
