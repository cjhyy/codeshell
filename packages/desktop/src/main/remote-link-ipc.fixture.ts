import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkSnapshot } from "@cjhyy/code-shell-link";

const issuer = "https://catalog.example";
const nativeFetch = globalThis.fetch;
let catalogRequests: Request[] = [];
let rejectedRequests = 0;
let authorizationWindows = 0;
let catalogResponse = async () => Response.json({ version: 1, providers: [] });

// Install the exact endpoint guard before importing Core or the IPC module.
// No OAuth exchange, grant refresh, provider content or real network is allowed.
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== `${issuer}/api/v1/links/providers` || request.method !== "GET") {
    rejectedRequests++;
    throw new Error("Link IPC fixture refuses uncontrolled fetch");
  }
  catalogRequests.push(request);
  return catalogResponse();
}) as typeof fetch;
mock.module("electron", () => ({
  app: { isPackaged: false, once: () => {} },
  BrowserWindow: {
    fromWebContents: () => {
      authorizationWindows++;
      throw new Error("Catalog refresh must not focus an authorization window");
    },
  },
  shell: {
    openExternal: async () => {
      authorizationWindows++;
      throw new Error("Catalog refresh must not open authorization");
    },
  },
}));
const { CredentialStore } = await import("@cjhyy/code-shell-core");
const { registerRemoteLinkIpc } = await import("./remote-link-ipc.js");

const cleanups: Array<() => void> = [];
beforeEach(() => {
  process.env.CODE_SHELL_REMOTE_LINK_ISSUER = issuer;
  process.env.CODE_SHELL_REMOTE_LINK_CLIENT_ID = "fixture-client";
  process.env.CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN = "http://127.0.0.1:43827";
  catalogRequests = [];
  rejectedRequests = 0;
  authorizationWindows = 0;
  catalogResponse = async () => Response.json({ version: 1, providers: [] });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(rejectedRequests).toBe(0);
  expect(authorizationWindows).toBe(0);
});
afterAll(() => {
  globalThis.fetch = nativeFetch;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FixtureContents extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-link-ipc-project-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const store = new CredentialStore(cwd);
  const handlers = new Map<string, (...args: any[]) => Promise<LinkSnapshot>>();
  const sender = new FixtureContents();
  const event = { sender, senderFrame: sender.mainFrame };
  let mainWindow = true;
  let projectAllowed = true;
  let projectChecks = 0;
  let mutations = 0;
  let changes = 0;
  let resolveProject = async (path: string) => {
    if (!projectAllowed || path !== cwd) throw new Error("project access denied");
    return cwd;
  };
  registerRemoteLinkIpc({
    ipcMain: { handle: (name, handler) => void handlers.set(name, handler) },
    requireRendererProjectPath: async (path) => {
      projectChecks++;
      return resolveProject(path);
    },
    isMainWindow: (contents) => mainWindow && contents === (sender as any),
    withMutation: async (_path, write) => {
      mutations++;
      return write();
    },
    onChanged: () => {
      changes++;
    },
  });
  cleanups.push(() => {
    sender.destroy();
    rmSync(root, { recursive: true, force: true });
    expect(mutations).toBe(0);
    expect(changes).toBe(0);
  });
  return {
    cwd,
    store,
    sender,
    event,
    snapshot: (force?: unknown, source = event, path: unknown = cwd) =>
      handlers.get("links:remoteSnapshot")!(source, path, force),
    revokeWindow: () => {
      mainWindow = false;
    },
    revokeProject: () => {
      projectAllowed = false;
    },
    setResolver: (resolver: typeof resolveProject) => {
      resolveProject = resolver;
    },
    get projectChecks() {
      return projectChecks;
    },
  };
}

function saveGrant(store: InstanceType<typeof CredentialStore>) {
  store.save("project", {
    id: "saved-remote-figma",
    type: "oauth",
    label: "Saved Figma account",
    secret: JSON.stringify({
      version: 1,
      accessToken: "synthetic-private-access",
      refreshToken: "synthetic-private-refresh",
      tokenType: "Bearer",
      issuer,
      clientId: "fixture-client",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
    meta: {
      linkProvider: "figma",
      linkConnectionMethod: "remote-link",
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteState: "connected",
      linkRemoteIssuer: issuer,
      linkRemoteConnectionId: "selected-connection",
      linkRemoteGrantId: "selected-grant",
      linkAccountId: "selected-account",
      linkAccountLabel: "Saved designer",
      linkResourceGroups: [{ id: "files", items: [{ id: "ExactFile", label: "Selected design" }] }],
      linkCapabilityIds: ["figma.get_file"],
      agentExposable: false,
    },
  });
}

test("only explicit true bypasses a fresh catalog and leaves saved grants and tokens unchanged", async () => {
  const f = fixture();
  saveGrant(f.store);
  const saved = f.store.resolve("saved-remote-figma");
  catalogResponse = async () =>
    Response.json({
      version: 1,
      providers: [
        {
          id: "github",
          actions: ["get_file"],
          scopes: ["github:get_file"],
          methods: [
            {
              id: "remote-link",
              authKind: "oauth",
              defaultAuthModeId: "browser",
              authModes: [{ id: "browser", kind: "redirect" }],
            },
          ],
        },
      ],
    });
  const first = await f.snapshot();
  const connection = first.connections.find((item) => item.id === saved!.id)!;
  expect(first.remoteCatalog?.state).toBe("ready");
  expect(first.capabilities.remoteAuth).toBe(true);
  expect(await f.snapshot(false)).toEqual(first);
  expect(await f.snapshot()).toEqual(first);
  expect(catalogRequests).toHaveLength(1);

  catalogResponse = async () => Response.json({ version: 1, providers: [] });
  const refreshed = await f.snapshot(true);
  expect(refreshed.capabilities.remoteAuth).toBe(false);
  expect(catalogRequests).toHaveLength(2);
  expect(await f.snapshot(false)).toEqual(refreshed);
  expect(catalogRequests).toHaveLength(2);

  catalogResponse = async () => new Response(null, { status: 503 });
  const unavailable = await f.snapshot(true);
  expect(unavailable.remoteCatalog).toMatchObject({ state: "stale", httpStatus: 503 });
  expect(unavailable.connections.find((item) => item.id === saved!.id)).toEqual(connection);
  expect(connection).toMatchObject({ status: "connected", account: { id: "selected-account" } });
  expect(f.store.resolve(saved!.id)).toEqual(saved);
  expect(catalogRequests).toHaveLength(3);
  for (const request of catalogRequests) {
    expect(request.headers.has("Authorization")).toBe(false);
    expect(await request.text()).toBe("");
  }
  expect(JSON.stringify(unavailable)).not.toContain("synthetic-private");
});

test("non-boolean force parameters fail before project resolution or discovery", async () => {
  const f = fixture();
  for (const value of [null, 0, 1, "true", {}, []])
    await expect(f.snapshot(value)).rejects.toThrow("目录刷新参数无效");
  expect(f.projectChecks).toBe(0);
  expect(catalogRequests).toHaveLength(0);
});

test("forced discovery still requires a live main window and its exact main frame", async () => {
  const f = fixture();
  await expect(f.snapshot(true, { ...f.event, senderFrame: {} })).rejects.toThrow("主窗口");
  const foreign = new FixtureContents();
  await expect(
    f.snapshot(true, { sender: foreign, senderFrame: foreign.mainFrame }),
  ).rejects.toThrow("主窗口");
  f.sender.destroy();
  await expect(f.snapshot(true)).rejects.toThrow("主窗口");
  expect(f.projectChecks).toBe(0);
  expect(catalogRequests).toHaveLength(0);
});

test("forced discovery cannot bypass project path authorization", async () => {
  const f = fixture();
  await expect(f.snapshot(true, f.event, join(f.cwd, "unapproved"))).rejects.toThrow(
    "project access denied",
  );
  await expect(f.snapshot(true, f.event, {})).rejects.toThrow("主窗口");
  expect(f.projectChecks).toBe(1);
  expect(catalogRequests).toHaveLength(0);
});

test("window authority is rechecked after an asynchronous project lookup", async () => {
  const f = fixture();
  const resolved = deferred<string>();
  f.setResolver(() => resolved.promise);
  const pending = f.snapshot(true);
  f.revokeWindow();
  resolved.resolve(f.cwd);
  await expect(pending).rejects.toThrow("窗口已关闭或刷新");
  expect(catalogRequests).toHaveLength(0);
});

test("project revocation during a forced catalog request rejects its result without changing grants", async () => {
  const f = fixture();
  saveGrant(f.store);
  const first = await f.snapshot();
  const saved = f.store.resolve("saved-remote-figma");
  const entered = deferred<void>();
  const response = deferred<Response>();
  catalogResponse = () => {
    entered.resolve();
    return response.promise;
  };
  const pending = f.snapshot(true);
  await entered.promise;
  f.revokeProject();
  response.resolve(Response.json({ version: 1, providers: [] }));
  await expect(pending).rejects.toThrow();
  expect(first.connections).toHaveLength(1);
  expect(f.store.resolve(saved!.id)).toEqual(saved);
  expect(catalogRequests).toHaveLength(2);
});

test("navigation retires the snapshot owner while a catalog request is pending", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const response = deferred<Response>();
  catalogResponse = () => {
    entered.resolve();
    return response.promise;
  };
  const pending = f.snapshot(true);
  await entered.promise;
  f.sender.emit("did-start-navigation", {}, "about:blank", false, true);
  response.resolve(Response.json({ version: 1, providers: [] }));
  await expect(pending).rejects.toThrow();
  expect(f.store.list()).toEqual([]);
  expect(catalogRequests).toHaveLength(1);
});
