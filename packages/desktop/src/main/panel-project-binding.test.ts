import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { guardProjectScopeNetwork } from "../../../server/src/panels/__fixtures__/project-scope-network.js";

guardProjectScopeNetwork(afterAll);
const {
  preparePanelAppStorage,
  writePanelAppStorage,
  readPanelAppStorage,
  panelAppStorageKey,
  panelAppStorageQuotaBytes,
  panelAppStorageChange,
  panelAppStorageSnapshot,
  applyPanelAppStorageChange,
} = await import("../../../server/src/panels/storage-store.js");
const { createDesktopPanelAutomationHost } = await import("./panel-automation-host.js");
const { CronScheduler } = await import("@cjhyy/code-shell-core/internal");

// Execute actual Main methods without Electron startup or replacing their bind logic.
const source = readFileSync(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const methods = [
  "bindGuest",
  "assertProjectBinding",
  "assertSessionBinding",
  "assertLiveProjectBinding",
  "assertTrustedHost",
  "bindingFor",
  "waitForBoundGuest",
  "contextFor",
  "call",
  "revokeGuest",
  "dispatch",
  "requirePermission",
  "submitPrompt",
  "panelAutomationHost",
  "panelAutomationScope",
  "conditionalPanelAutomation",
  "automationId",
  "listPanelAutomations",
  "requireScopedPanelAutomation",
  "createPanelAutomation",
  "updatePanelAutomation",
  "controlPanelAutomation",
  "trustedWorkspaceRoot",
  "isWithinWorkspace",
  "ensureWorkspaceDirectory",
  "writeWorkspaceFile",
  "pinWorkspaceDirectory",
  "withWorkspaceWrite",
  "readBoundedWorkspaceFile",
  "writeStorage",
  "withStorageMutation",
  "storageVersioned",
  "storageSet",
  "storageDelete",
].map((name) => {
  const method = declaration.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name,
  );
  if (!method) throw new Error(`Missing real bridge method: ${name}`);
  return method.getText(parsed);
});
const compiled = ts.transpileModule(`class BindingBridge { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const storageSource = readFileSync(
  new URL("../../../server/src/panels/storage-store.ts", import.meta.url),
  "utf8",
);
const parsedStorage = ts.createSourceFile(
  "storage.ts",
  storageSource,
  ts.ScriptTarget.Latest,
  true,
);
const writer = parsedStorage.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "writePanelAppStorage",
)!;
const compiledWriter = ts.transpileModule(writer.getText(parsedStorage).replace(/^export /, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function scope(rootId = "root") {
  return {
    scope: { version: 1, environmentId: "environment", projectId: "project", rootId },
    assertCurrent() {},
  };
}
function fixture(permissions = ["context.workspace", "context.session"]) {
  const owner = {
    id: 1,
    closed: false,
    isDestroyed() {
      return this.closed;
    },
  };
  const sender = { id: 2 };
  const events: unknown[] = [];
  const guest = {
    id: 3,
    closed: false,
    isDestroyed() {
      return this.closed;
    },
    send(_channel: string, event: unknown) {
      events.push(event);
    },
  };
  const binding = {
    guest,
    ownerWindowId: owner.id,
    resource: { descriptor: { id: "descriptor", appId: "panel", permissions } },
    projectPath: "/project",
    context: {},
    callTimes: [],
    recordingWriteTimes: [],
  };
  let afterTempWrite: (() => Promise<void>) | undefined;
  let storageWriter = writePanelAppStorage;
  const Bridge = runInNewContext(`${compiled}\nBindingBridge`, {
    AbortController,
    isDeepStrictEqual,
    setTimeout,
    Buffer,
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      await afterTempWrite?.();
    },
    preparePanelAppStorage,
    readPanelAppStorage,
    panelAppStorageChange,
    panelAppStorageSnapshot,
    applyPanelAppStorageChange,
    writePanelAppStorage: (...args: Parameters<typeof writePanelAppStorage>) =>
      storageWriter(...args),
    acquireLockOnPath: () => () => {},
    chmodSync,
    constants,
    linkSync,
    lstatSync,
    realpathSync,
    renameSync,
    basename,
    dirname,
    join,
    resolve,
    sep,
    workspaceRevision: (value: Uint8Array) =>
      "sha256:" + createHash("sha256").update(value).digest("hex"),
    resolvePanelAppBindingProjectPath: (path: string) =>
      path === "/project-worktree" ? "/project" : path,
    isPanelAppDescriptorSelected: () => true,
    BrowserWindow: {
      fromWebContents: (value: unknown) => (value === sender ? owner : undefined),
      fromId: () => owner,
    },
    PANEL_APP_API_VERSION: 14,
    PanelBridgeError: class extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(message);
      }
    },
    RESOURCE_TRANSFER_METHODS: new Set(),
    jsonBytes: (value: unknown) => JSON.stringify(value)?.length ?? 0,
    MAX_PARAMS_BYTES: 1_000_000,
    MAX_RESULT_BYTES: 1_000_000,
    MAX_WORKSPACE_READ_BYTES: 1_000_000,
    RATE_WINDOW_MS: 60_000,
    MAX_CALLS_PER_WINDOW: 1000,
    CALL_TIMEOUT_MS: 1000,
    MAX_AGENT_PROMPT_CHARS: 20_000,
    PANEL_AGENT_RUN_TIMEOUT_MS: 1000,
    panelExecutionGate: { run: (_scope: unknown, operation: () => unknown) => operation() },
    withTimeout: (operation: unknown) => operation,
    randomUUID: () => "fixture",
    parseExternalRuntimeModelKey: (key: string) =>
      key === "external" ? { kind: "fixture" } : null,
    claimPanelHostOwnerForRun() {},
  });
  const bridge = new Bridge();
  bridge.guests = new Map([[guest.id, binding]]);
  bridge.resourceTransfers = new Map();
  bridge.pendingAgentToolCalls = new Map();
  bridge.processService = { revokeGuest() {} };
  bridge.agentTaskService = { rebind() {} };
  bridge.agentTaskOwner = () => ({ projectPath: "/project" });
  bridge.workspaceWriteQueues = new Map();
  bridge.options = {
    isTrustedHost: (value: unknown) => value === sender,
    isPanelAppBound: () => true,
    isWorkspaceTrusted: () => true,
    resolveProjectScope: async () => scope(),
  };
  bridge.capabilitiesFor = () => ({ host: "desktop" });
  const input = {
    guestId: guest.id,
    appDescriptorId: "descriptor",
    tabId: "tab",
    bucket: "bucket",
    projectPath: "/project",
    cwd: "/project",
    sessionId: "session-a",
    locale: "en",
  };
  return {
    bridge,
    binding,
    guest,
    sender,
    owner,
    input,
    events,
    stageWrite(action: () => Promise<void>) {
      afterTempWrite = action;
    },
    useStorageWriter(writer: typeof writePanelAppStorage) {
      storageWriter = writer;
    },
  };
}

test("native context takes all stable identity fields only from the Host and survives Session rebinding", async () => {
  const f = fixture();
  await f.bridge.bindGuest(f.sender, {
    ...f.input,
    projectScope: { environmentId: "forged" },
    projectId: "forged",
  });
  expect(f.bridge.contextFor(f.guest).projectScope).toEqual(scope().scope);
  await f.bridge.bindGuest(f.sender, { ...f.input, sessionId: "session-b", bucket: "new-bucket" });
  expect(f.bridge.contextFor(f.guest)).toMatchObject({
    sessionId: "session-b",
    projectScope: scope().scope,
  });
});

test("without context.workspace the resolver is never called and identity is never exposed", async () => {
  const f = fixture(["context.session"]);
  f.bridge.options.resolveProjectScope = () => {
    throw Error("must not resolve");
  };
  await f.bridge.bindGuest(f.sender, f.input);
  expect(f.bridge.contextFor(f.guest)).not.toHaveProperty("projectScope");
  expect(f.bridge.contextFor(f.guest)).not.toHaveProperty("cwd");
});

test("older asynchronous binds cannot replace a newer Session, bucket or identity", async () => {
  const f = fixture();
  let finishOld!: (value: ReturnType<typeof scope>) => void;
  f.bridge.options.resolveProjectScope = () =>
    new Promise((resolve) => {
      finishOld = resolve;
    });
  const old = f.bridge.bindGuest(f.sender, f.input).then(
    () => "unexpected success",
    (error: Error) => error.message,
  );
  f.bridge.options.resolveProjectScope = async () => scope();
  await f.bridge.bindGuest(f.sender, { ...f.input, sessionId: "session-new", bucket: "new" });
  expect(await old).toContain("superseded");
  finishOld(scope("stale-root"));
  await Promise.resolve();
  expect(f.bridge.contextFor(f.guest)).toMatchObject({
    sessionId: "session-new",
    projectScope: scope().scope,
  });
  expect((f.binding as { bucket?: string }).bucket).toBe("new");
  expect(f.events).toHaveLength(1);
});

test("guest revocation cancels a pending bind without waiting for its resolver", async () => {
  const f = fixture();
  f.bridge.options.resolveProjectScope = () => new Promise(() => {});
  const pending = f.bridge.bindGuest(f.sender, f.input).then(
    () => "unexpected success",
    (error: Error) => error.message,
  );
  f.bridge.revokeGuest(f.guest.id);
  expect(await pending).toContain("closed");
  expect(f.events).toHaveLength(0);
});

test("owner and authorization are rechecked after scope resolution", async () => {
  const f = fixture();
  let finish!: (value: ReturnType<typeof scope>) => void;
  f.bridge.options.resolveProjectScope = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = f.bridge.bindGuest(f.sender, f.input);
  f.owner.closed = true;
  finish(scope());
  await expect(pending).rejects.toThrow("closed");
  expect(f.events).toHaveLength(0);
});

test("changed identity or revoked mount permanently rejects bind, context.get and Host calls", async () => {
  const f = fixture();
  await f.bridge.bindGuest(f.sender, f.input);
  f.bridge.options.resolveProjectScope = async () => scope("replacement");
  await expect(
    f.bridge.bindGuest(f.sender, { ...f.input, cwd: "/project-worktree" }),
  ).rejects.toThrow("scope changed");
  f.bridge.options.resolveProjectScope = async () => scope();
  await expect(f.bridge.bindGuest(f.sender, f.input)).rejects.toThrow("revoked");
  expect(() => f.bridge.contextFor(f.guest)).toThrow("revoked");
  await expect(f.bridge.call(f.guest, "storage.get", { key: "value" })).rejects.toThrow("revoked");
});

test("frozen authority guard runs on context.get, every Host call and repeated bind", async () => {
  const f = fixture();
  let valid = true;
  f.bridge.options.resolveProjectScope = async () => ({
    ...scope(),
    assertCurrent() {
      if (!valid) throw Error("mount replaced");
    },
  });
  await f.bridge.bindGuest(f.sender, f.input);
  valid = false;
  expect(() => f.bridge.contextFor(f.guest)).toThrow("mount replaced");
  await expect(f.bridge.call(f.guest, "storage.get", {})).rejects.toThrow("revoked");
  await expect(f.bridge.bindGuest(f.sender, f.input)).rejects.toThrow("revoked");
});

test("actual Main call rechecks the frozen scope and guest before returning an awaited result", async () => {
  for (const revocation of ["scope", "guest", "shutdown"]) {
    const f = fixture();
    let valid = true;
    f.bridge.options.resolveProjectScope = async () => ({
      ...scope(),
      assertCurrent() {
        if (!valid) throw Error("mount replaced");
      },
    });
    await f.bridge.bindGuest(f.sender, f.input);
    let finish!: (value: unknown) => void;
    f.bridge.dispatchToolJobs = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = f.bridge.call(f.guest, "tasks.list", {});
    await Promise.resolve();
    if (revocation === "scope") valid = false;
    if (revocation === "guest") f.bridge.revokeGuest(f.guest.id);
    if (revocation === "shutdown") f.bridge.resourceTransfersStopping = true;
    finish({ secret: "must not return" });
    await expect(pending).rejects.toThrow(
      revocation === "scope" ? "mount replaced" : "no longer bound",
    );
    if (revocation === "scope") {
      valid = true;
      await expect(f.bridge.call(f.guest, "tasks.list", {})).rejects.toThrow("revoked");
    }
  }
});

const sensitivePermissions = [
  "context.workspace",
  "context.session",
  "agent.submitPrompt",
  "automations.manage",
  "agent.task",
];
const automationInput = {
  name: "daily",
  schedule: "1h",
  prompt: "check",
  id: "job",
  key: "fixture",
};

function sensitiveFixture() {
  const f = fixture(sensitivePermissions);
  let effects = 0;
  f.bridge.options.getAgentBridge = () => ({
    requestWorker: async () => {
      effects++;
      return { ok: true };
    },
    ingestExternalEvent() {},
  });
  f.binding.resource.descriptor.title = "Scope";
  f.bridge.options.automations = {
    uniqueCreation: true,
    list: async () => {
      effects++;
      return [{ id: "job" }];
    },
    create: async () => {
      effects++;
      return { id: "job" };
    },
    update: async () => {
      effects++;
      return {};
    },
    pause: async () => {
      effects++;
      return true;
    },
    resume: async () => {
      effects++;
      return true;
    },
    delete: async () => {
      effects++;
      return true;
    },
    runNow: async () => {
      effects++;
      return true;
    },
  };
  return {
    ...f,
    effects: () => effects,
    reset() {
      effects = 0;
    },
  };
}

test("actual Main bridge rejects session-sensitive IPC after precheck and rebind before guest event delivery", async () => {
  const f = sensitiveFixture();
  await f.bridge.bindGuest(f.sender, f.input);
  expect(await f.bridge.call(f.guest, "agent.submitPrompt", { prompt: "allowed" })).toMatchObject({
    accepted: true,
  });
  expect(
    await f.bridge.call(f.guest, "automations.create", {
      name: "daily",
      schedule: "1h",
      prompt: "allowed",
    }),
  ).toEqual({ id: "job" });
  expect(f.effects()).toBe(2);
  f.reset();
  // Events are queued in the guest's transport; this snapshot represents the
  // client's successful precheck before Main receives the renderer rebind.
  const precheck = await f.bridge.call(f.guest, "context.get");
  expect(precheck.sessionId).toBe("session-a");
  await f.bridge.bindGuest(f.sender, { ...f.input, sessionId: "session-b" });
  for (const method of [
    "agent.submitPrompt",
    "automations.list",
    "automations.create",
    "automations.createUnique",
    "automations.update",
    "automations.pause",
    "automations.resume",
    "automations.delete",
    "automations.runNow",
    "automations.updateIfRevision",
    "automations.deleteIfRevision",
  ])
    await expect(f.bridge.call(f.guest, method, automationInput)).rejects.toThrow(
      "session changed",
    );
  expect(f.effects()).toBe(0);
  expect((await f.bridge.call(f.guest, "context.get")).projectScope).toEqual(precheck.projectScope);
  f.bridge.dispatchToolJobs = async () => ({ project: true });
  expect(await f.bridge.call(f.guest, "tasks.list", {})).toEqual({ project: true });
  await f.bridge.bindGuest(f.sender, f.input);
  await expect(
    f.bridge.call(f.guest, "agent.submitPrompt", { prompt: "old session" }),
  ).rejects.toThrow("session changed");
  expect(f.effects()).toBe(0);
});

test("first real session is frozen and losing it permanently revokes sensitive actions", async () => {
  const f = sensitiveFixture();
  await f.bridge.bindGuest(f.sender, { ...f.input, sessionId: undefined });
  await f.bridge.bindGuest(f.sender, f.input);
  expect(await f.bridge.call(f.guest, "automations.list", {})).toEqual({
    automations: [{ id: "job" }],
  });
  f.reset();
  await f.bridge.bindGuest(f.sender, { ...f.input, sessionId: undefined });
  await f.bridge.bindGuest(f.sender, f.input);
  await expect(f.bridge.call(f.guest, "automations.list", {})).rejects.toThrow("session changed");
  expect(f.effects()).toBe(0);
});

test("automation lookup await cannot authorize a mutation after Main rebinds the guest", async () => {
  for (const method of [
    "automations.update",
    "automations.pause",
    "automations.resume",
    "automations.delete",
    "automations.runNow",
    "automations.list",
  ]) {
    const f = sensitiveFixture();
    await f.bridge.bindGuest(f.sender, f.input);
    let finish!: (jobs: unknown[]) => void;
    f.bridge.options.automations.list = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = f.bridge.call(f.guest, method, automationInput);
    await Promise.resolve();
    await f.bridge.bindGuest(f.sender, { ...f.input, sessionId: "session-b" });
    finish([{ id: "job" }]);
    await expect(pending).rejects.toThrow("session changed");
    expect(f.effects()).toBe(0);
  }
});

test("external runtime context await rechecks the session before ensure or send", async () => {
  const f = sensitiveFixture();
  let finish!: (context: string) => void;
  let dispatched = 0;
  f.bridge.options.externalRuntimeInitialContext = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.bridge.options.getExternalRuntimeService = () => ({
    isCompatible: () => false,
    ensure: async () => {
      dispatched++;
    },
    send: async () => {
      dispatched++;
      return { ok: true };
    },
  });
  await f.bridge.bindGuest(f.sender, { ...f.input, modelKey: "external" });
  expect(await f.bridge.call(f.guest, "agent.submitPrompt", { prompt: "queued" })).toMatchObject({
    accepted: true,
  });
  await f.bridge.bindGuest(f.sender, { ...f.input, sessionId: "session-b" });
  finish("context");
  await Promise.resolve();
  await Promise.resolve();
  expect(dispatched).toBe(0);
  expect(f.effects()).toBe(0);
});

test("real production automation Host rechecks native session after durable authority lookup", async () => {
  const f = sensitiveFixture();
  const scheduler = new CronScheduler();
  scheduler.setExecutionEnabled(false);
  let lookup!: () => void;
  let finish!: () => void;
  const lookedUp = new Promise<void>((resolve) => {
    lookup = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.bridge.options.automations.conditional = createDesktopPanelAutomationHost(
    () => ({
      requireRendererPath: async (cwd: string) => cwd,
      isNoRepoCwd: () => false,
      resolveExactRoot: () => undefined,
      resolveProjectRootById: () => ({ projectId: "project", rootId: "root", cwd: "/project" }),
      resolveSessionAuthority: async (sessionId: string) => {
        lookup();
        await blocked;
        return { sessionId, cwd: "/project", projectId: "project", rootId: "root" };
      },
    }),
    () => scheduler,
  );
  try {
    await f.bridge.bindGuest(f.sender, f.input);
    const pending = f.bridge.call(f.guest, "automations.create", {
      name: "daily",
      schedule: "1h",
      prompt: "queued",
    });
    await lookedUp;
    await f.bridge.bindGuest(f.sender, { ...f.input, sessionId: "session-b" });
    finish();
    await expect(pending).rejects.toThrow("authorization expired");
    expect(scheduler.list()).toEqual([]);
    expect(f.effects()).toBe(0);
  } finally {
    scheduler.stopAll();
  }
});

test("queued/staged workspace writes never commit into a replaced root or parent", async () => {
  for (const replacement of ["queue-root", "staged-root", "staged-parent", "registry"]) {
    const root = mkdtempSync(join(tmpdir(), "panel-scope-write-"));
    try {
      const project = join(root, "project");
      mkdirSync(join(project, "sub"), { recursive: true });
      const f = fixture();
      f.binding.projectPath = project;
      let valid = true;
      f.bridge.options.resolveProjectScope = async () => ({
        ...scope(),
        assertCurrent() {
          if (!valid) throw Error("registry revoked");
        },
      });
      await f.bridge.bindGuest(f.sender, { ...f.input, projectPath: project, cwd: project });
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (replacement === "queue-root") {
        f.bridge.workspaceWriteQueues.set(join(project, "sub/result.txt"), blocked);
        const enqueue = f.bridge.withWorkspaceWrite.bind(f.bridge);
        f.bridge.withWorkspaceWrite = (file: string, mutate: () => Promise<unknown>) => {
          const result = enqueue(file, mutate);
          entered();
          return result;
        };
      } else
        f.stageWrite(async () => {
          entered();
          await blocked;
        });
      const pending = f.bridge.writeWorkspaceFile(
        f.binding,
        "sub/result.txt",
        Buffer.from("new"),
        null,
        undefined,
        100,
      );
      await ready;
      if (replacement === "registry") valid = false;
      else {
        const replaced = replacement === "staged-parent" ? join(project, "sub") : project;
        renameSync(replaced, replaced + "-old");
        mkdirSync(join(project, "sub"), { recursive: true });
      }
      release();
      await expect(pending).rejects.toThrow(
        replacement === "registry" ? "registry revoked" : "directory changed",
      );
      expect(existsSync(join(project, "sub/result.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("guarded workspace writes retain ordinary create and replace behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "panel-scope-write-ok-"));
  try {
    const f = fixture();
    f.binding.projectPath = root;
    await f.bridge.bindGuest(f.sender, { ...f.input, projectPath: root, cwd: root });
    const created = await f.bridge.writeWorkspaceFile(
      f.binding,
      "result.txt",
      Buffer.from("first"),
      null,
      undefined,
      100,
    );
    await f.bridge.writeWorkspaceFile(
      f.binding,
      "result.txt",
      Buffer.from("second"),
      created.modifiedAt,
      undefined,
      100,
    );
    expect(readFileSync(join(root, "result.txt"), "utf8")).toBe("second");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy storage writes use the real before-commit authorization hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "panel-scope-storage-"));
  try {
    const f = fixture(["context.workspace", "context.session", "storage"]);
    await f.bridge.bindGuest(f.sender, f.input);
    f.bridge.storageQuotaBytes = () => 1024;
    const file = join(root, "storage/value.json");
    await f.bridge.writeStorage(f.binding, file, { value: "first" });
    f.bridge.guests.delete(f.guest.id);
    await expect(f.bridge.writeStorage(f.binding, file, { value: "revoked" })).rejects.toThrow(
      "no longer bound",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ value: "first" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real final storage prepare cannot publish after guest or registry revocation", async () => {
  for (const method of ["storage.set", "storage.delete", "storage.compareAndSet"])
    for (const revocation of ["guest", "registry"]) {
      const root = mkdtempSync(join(tmpdir(), "panel-scope-storage-final-"));
      try {
        const f = fixture(["context.workspace", "context.session", "storage"]);
        let valid = true;
        f.bridge.options.resolveProjectScope = async () => ({
          ...scope(),
          assertCurrent() {
            if (!valid) throw Error("registry revoked");
          },
        });
        await f.bridge.bindGuest(f.sender, f.input);
        const file = join(root, "storage/value.json");
        const original = { value: "first" };
        await writePanelAppStorage(file, original, 4096);
        f.bridge.storagePath = () => file;
        f.bridge.storageQuotaBytes = () => 4096;
        f.bridge.storageKey = panelAppStorageKey;
        f.bridge.readStorage = () => readPanelAppStorage(file, 4096);
        f.bridge.storageQueues = new Map();
        let entered!: () => void;
        let release!: () => void;
        const staged = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        let prepares = 0;
        // Execute the actual storage writer with real filesystem operations;
        // only its final asynchronous prepare is held at the controlled boundary.
        f.useStorageWriter(
          runInNewContext(`${compiledWriter}\nwritePanelAppStorage`, {
            ...fs,
            renameSync,
            randomUUID,
            Buffer,
            process,
            panelAppStorageQuotaBytes,
            MAX_PANEL_APP_STORAGE_KEYS: 10_000,
            STORAGE_KEY_PATTERN: /^[a-zA-Z0-9._-]{1,80}$/,
            preparePanelAppStorage: async (path: string) => {
              await preparePanelAppStorage(path);
              if (++prepares === 2) {
                entered();
                await blocked;
              }
            },
          }),
        );
        const params = {
          key: "value",
          value: "revoked",
          expectedRevision: panelAppStorageSnapshot(original, "value").revision,
        };
        const pending = f.bridge.call(f.guest, method, params);
        await staged;
        if (revocation === "guest") f.bridge.guests.delete(f.guest.id);
        else valid = false;
        release();
        await expect(pending).rejects.toThrow(/scope changed|no longer bound|registry revoked/);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
});
