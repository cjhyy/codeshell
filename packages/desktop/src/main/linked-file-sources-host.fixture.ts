import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "bun:test";

let requests = 0;
const deny = () => {
  requests++;
  throw new Error("native file selection must not fetch");
};
globalThis.fetch = deny as unknown as typeof fetch;
http.get = deny as typeof http.get;
http.request = deny as typeof http.request;
https.get = deny as typeof https.get;
https.request = deny as typeof https.request;
syncBuiltinESMExports();
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));

const scratch = mkdtempSync(join(tmpdir(), "cs-native-linked-files-"));
mkdirSync(join(scratch, "project"));
const cwd = realpathSync(join(scratch, "project"));
process.env.CODE_SHELL_HOME = join(scratch, "state");
process.env.CODE_SHELL_REMOTE_LINK_DISABLED = "1";
const frame = { processId: 1, routingId: 2, isDestroyed: () => false };
const sender = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
const owner = { isDestroyed: () => false };
const event = { sender, senderFrame: frame };
const project = {
  id: "project-a",
  primaryRootId: "root-a",
  roots: [{ id: "root-a", path: cwd, canonicalIdentity: cwd }],
};
const listeners = new Set<(projects: any[]) => void>();
mock.module("electron", () => ({
  app: Object.assign(new EventEmitter(), { isPackaged: false }),
  BrowserWindow: { fromWebContents: () => owner },
  shell: {
    openExternal: async () => {
      throw new Error("no authorization should open");
    },
  },
}));
mock.module("./project-store.js", () => ({
  getProjectStore: () => ({
    list: async () => [structuredClone(project)],
    onChanged: (listener: (projects: any[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }),
}));
const realService = await import("../../../server/src/links/service.js");
const remoteConfiguration = await import("../../../server/src/links/remote-configuration.js");
mock.module("@cjhyy/code-shell-server/links", () => ({ ...realService, ...remoteConfiguration }));
const { CredentialStore, PlaintextCipher, SettingsManager } =
  await import("@cjhyy/code-shell-core");
const { listSourceDefinitions } = await import("@cjhyy/code-shell-core/internal");
const { registerRemoteLinkIpc } = await import("./remote-link-ipc.js");
const { openLinkedFileSourceOperation } = await import("./linked-file-sources-host.js");
const { registerLinkedFileSourceIpc } = await import("./linked-file-sources-ipc.js");
new CredentialStore(cwd, new PlaintextCipher()).save("user", {
  id: "github-native",
  type: "link",
  label: "Native GitHub account",
  secret: "synthetic-hidden-token",
  meta: {
    linkProvider: "github",
    linkExecutionRuntime: "local",
    linkExecutionBackend: "http-token",
    linkConnectionMethod: "fine-grained-pat",
    linkAuthSource: "manual-token",
    linkAccountId: "fixture-account",
    linkAccountLabel: "Fixture account",
    linkCapabilityIds: ["github.get_file"],
  },
});
const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const ipcMain = {
  handle: (channel: string, handler: (...args: any[]) => Promise<any>) => {
    handlers.set(channel, handler);
  },
};
const remote = registerRemoteLinkIpc({
  ipcMain,
  requireRendererProjectPath: async (path) => {
    assert.ok(project.roots.some((root) => root.path === path));
    return path;
  },
  isMainWindow: () => true,
  withMutation: async (_cwd, run) => run(),
  onChanged() {},
});
registerLinkedFileSourceIpc({
  ipcMain,
  open: (invocation) =>
    openLinkedFileSourceOperation(invocation, () => true, remote.storedSnapshot),
});
try {
  const snapshot = await handlers.get("sources:linkedFiles:snapshot")!(event, "project-a");
  assert.equal(snapshot.connections.length, 1);
  assert.equal(listeners.size, 0);
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-hidden-token"));
  const input = {
    connectionId: snapshot.connections[0].id,
    expectedRevision: snapshot.connections[0].revision,
    files: [{ kind: "github-file", owner: "owner", repo: "docs", path: "manual.md" }],
    priority: "high",
  };
  // A different invocation must reuse the real service's per-instance connection revision.
  const added = await handlers.get("sources:linkedFiles:add")!(event, "project-a", input);
  assert.equal(added.sourceIds.length, 1);
  assert.equal(new SettingsManager(cwd, "full").getForScope("project", cwd).sources?.length, 1);
  assert.equal(listeners.size, 0);
  assert.deepEqual(
    await handlers.get("sources:linkedFiles:add")!(event, "project-a", input),
    added,
  );

  mkdirSync(join(scratch, "other-root"));
  const other = realpathSync(join(scratch, "other-root"));
  project.roots.push({ id: "root-b", path: other, canonicalIdentity: other });
  project.primaryRootId = "root-b";
  await assert.rejects(
    handlers.get("sources:linkedFiles:add")!(event, "project-a", input),
    /主目录/,
  );
  assert.equal(new SettingsManager(other, "full").getForScope("project", other).sources, undefined);
  assert.equal(listSourceDefinitions().length, 1);
  assert.equal(listeners.size, 0);

  const currentSnapshot = await handlers.get("sources:linkedFiles:snapshot")!(event, "project-a");
  let release!: () => void;
  let ready!: () => void;
  const opened = new Promise<void>((done) => {
    ready = done;
  });
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  registerLinkedFileSourceIpc({
    ipcMain,
    open: (invocation) =>
      openLinkedFileSourceOperation(
        invocation,
        () => true,
        async (invocation, cwd) => {
          const read = await remote.storedSnapshot(invocation, cwd);
          ready();
          await blocked;
          return read;
        },
      ),
  });
  const pending = handlers.get("sources:linkedFiles:add")!(event, "project-a", {
    ...input,
    expectedRevision: currentSnapshot.connections[0].revision,
    files: [{ kind: "github-file", owner: "owner", repo: "docs", path: "another.md" }],
  });
  await opened;
  sender.emit("did-start-navigation", {}, "https://example.invalid", false, true);
  release();
  await assert.rejects(pending, /窗口已关闭或导航/);
  assert.equal(listSourceDefinitions().length, 1);
  assert.equal(new SettingsManager(other, "full").getForScope("project", other).sources, undefined);
  assert.equal(listeners.size, 0);
  assert.equal(requests, 0);
  process.stdout.write(JSON.stringify({ passed: true, requests }));
} finally {
  sender.emit("destroyed");
  rmSync(scratch, { recursive: true, force: true });
}
