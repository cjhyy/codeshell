import { expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  readRemoteProviderCatalog,
  readRemoteProviderCapabilities,
  REMOTE_LINK_ADAPTERS,
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
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(status, {
      "Content-Type": "application/json",
      ...(status === 302 ? { Location: "https://example.invalid/untrusted" } : {}),
    });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  try {
    return await (capabilities ? readRemoteProviderCapabilities : readRemoteProviderCatalog)({
      issuer: `http://127.0.0.1:${address.port}`,
      clientId: "catalog-test",
      redirectUri: "http://127.0.0.1:9876/callback",
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    expect(requests).toEqual(["/api/v1/links/providers"]);
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
  expect(await catalog({ version: 1, providers: [expanded] })).toEqual([]);
  const changed = github();
  changed.methods[0]!.authModes[0]!.kind = "qr-code";
  expect(await catalog({ version: 1, providers: [changed] })).toEqual([]);
});

test("ambiguous and malformed remote catalogs fail closed", async () => {
  expect(await catalog({ version: 1, providers: [github(), github()] })).toEqual([]);
  expect(await catalog({ version: 2, providers: [github()] })).toEqual([]);
  expect(await catalog("not JSON")).toEqual([]);
  expect(await catalog(" ".repeat(32_769))).toEqual([]);
});

test("only legacy missing-catalog responses use the reviewed GitHub fallback", async () => {
  expect(await catalog({}, 404)).toEqual(["github"]);
  expect(await catalog({}, 501)).toEqual(["github"]);
  await expect(catalog({}, 500)).rejects.toThrow("Link catalog unavailable");
});

test("remote catalog never follows redirects to an untrusted source", async () => {
  await expect(catalog({}, 302)).rejects.toThrow();
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
  expect(providers.flatMap((provider) => provider.actions)).toHaveLength(29);
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

test("provider catalogs cannot borrow another provider's action scopes or hide extra authority", async () => {
  const provider = allProviders()[1]!;
  for (const scopes of [
    ["github:list_projects", "gitlab:list_issues"],
    [...provider.scopes, "gitlab:create_issue"],
    ["gitlab:list_projects", "gitlab:list_projects"],
  ]) {
    expect(await catalog({ version: 1, providers: [{ ...provider, scopes }] }, 200, true)).toEqual(
      [],
    );
  }
  const legacy = await catalog({}, 404, true);
  expect(legacy).toEqual([
    {
      id: "github",
      actions: ["list_repositories", "list_issues", "get_issue"],
      scopes: ["github:list_repositories", "github:list_issues", "github:get_issue"],
    },
  ]);
});
