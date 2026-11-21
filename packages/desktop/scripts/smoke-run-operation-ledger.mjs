// Real desktop stdio executor, private Node IPC descriptor and SQLite storage worker.
// Supply Electron's Node binary through scripts/run-isolated-node-smoke.mjs.
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { startMockProviderServer } from "./mock-provider-server.mjs";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";

const root = process.env.CODE_SHELL_TEST_HOME;
assert(root && root === process.env.CODE_SHELL_HOME, "Use the isolated smoke launcher");
assert.equal(process.versions.node.split(".")[0], "24");
assert(process.versions.electron, "Run with Electron's embedded Node");
const desktop = fileURLToPath(new URL("../", import.meta.url));
const cwd = join(root, "workspace"),
  sessions = join(root, "sessions");
await mkdir(join(cwd, ".code-shell"), { recursive: true });
await symlink(
  join(desktop, "node_modules"),
  join(root, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
const service = join(root, "host.mjs"),
  storageFile = join(root, "storage.mjs");
async function buildService(entry, outfile) {
  await build({
    ...entry,
    absWorkingDir: desktop,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    tsconfigRaw: {},
    outfile,
  });
}
await Promise.all([
  buildService(
    {
      stdin: {
        contents:
          'export {HostRunOperations} from "./src/host/composition/run-operations.ts";export {WorkerRunOperations} from "./src/main/desktop-host/worker-run-operations.ts";',
        resolveDir: desktop,
      },
    },
    service,
  ),
  buildService({ entryPoints: ["src/main/task-inbox/task-storage-worker.ts"] }, storageFile),
]);
const model = await startMockProviderServer();
installLocalNetworkGuard(model.origin);
const req = createRequire(new URL("../package.json", import.meta.url));
const workerEntry = req.resolve("@cjhyy/code-shell-core/bin/agent-server-stdio");
const source = new URL("../../../scripts/runtime-cost-smoke-isolation.mjs", import.meta.url);
const entry = join(root, "executor.mjs");
await writeFile(
  entry,
  `import { installLocalNetworkGuard } from ${JSON.stringify(source.href)}; installLocalNetworkGuard(${JSON.stringify(model.origin)}); await import(${JSON.stringify(pathToFileURL(workerEntry).href)});`,
);
await writeFile(
  join(cwd, ".code-shell/settings.local.json"),
  JSON.stringify({
    credentials: [
      { id: "fixture", catalogId: "openai", apiKey: "fixture", baseUrl: model.baseUrl },
    ],
    modelConnections: [
      {
        id: "fixture",
        catalogId: "openai",
        tag: "text",
        model: "gpt-4o-mini",
        credentialId: "fixture",
      },
    ],
    defaults: { text: "fixture" },
    autoUpdates: false,
  }),
);
const { OperationLedger } = await import("../../core/dist/operations/ledger.js");
const { openStateStorage } = await import("@cjhyy/code-shell-core/internal/storage");
const { WorkerBridgeCore } = await import("@cjhyy/code-shell-server/worker");
const { HostRunOperations, WorkerRunOperations } = await import(pathToFileURL(service).href);
const key = { wrapped: "enc:fixture:protected-ledger", secret: randomBytes(32).toString("hex") };
const ledger = new OperationLedger(
  sessions,
  {
    encrypt() {
      throw new Error("Unprepared key");
    },
    decrypt(wrapped) {
      assert.equal(wrapped, key.wrapped);
      return key.secret;
    },
  },
  undefined,
  key.wrapped,
);
ledger.prepare({
  sessionId: "other",
  intentId: "preexisting",
  action: "create_issue",
  service: "github",
  channel: "local-link",
  account: "fixture",
  target: "fixture",
  parameters: {},
  postcondition: {},
});
const db = openStateStorage(sessions, { workerUrl: pathToFileURL(storageFile) });
const methods = [];
const host = new HostRunOperations(
  db,
  async (create) => {
    assert.equal(create, false);
    assert.equal(await (await db).request("operations/wrappedKey"), key.wrapped);
    return key;
  },
  () => ({ assertCurrent() {} }),
);
const sessionsByWorker = new WorkerRunOperations(host, () => core.hasLiveWorker());
const core = new WorkerBridgeCore({
  entryPath: entry,
  execPath: process.execPath,
  buildEnv: () => ({
    ...process.env,
    CODE_SHELL_DATA_ROOT: root,
    AGENT_CWD: cwd,
    CODE_SHELL_PRIVATE_LEDGER: "host",
    CODE_SHELL_CREDENTIAL_ACCESS: "local",
    ELECTRON_RUN_AS_NODE: "1",
  }),
  operationLedger: async (request, current) => {
    const result = await sessionsByWorker.run(request, current);
    assert.equal(typeof result, "boolean");
    methods.push(request.method);
    return result;
  },
  onOperationDisconnect: () => sessionsByWorker.close(),
  onExit: () => sessionsByWorker.close(),
});
let exposed = false;
core.subscribeLines((line) => {
  exposed ||= line.includes(key.wrapped) || line.includes(key.secret);
  sessionsByWorker.observe(JSON.parse(line));
});
const timeout = setTimeout(() => core.kill(), 60000);
try {
  assert.equal((await db).mode, "sqlite");
  for (const generation of [1, 2]) {
    core.ensureWorker(cwd);
    assert.equal(core.workerGeneration(), generation);
    const opt = { failFast: true, settleOnExit: true, consume: true, timeoutMs: 25000 };
    const init = await core.request("initialize", {}, { ...opt, id: "smoke-init" });
    assert.equal(init.status, "result");
    const result = await core.request(
      "agent/run",
      {
        sessionId: "fixture-run",
        task: "Reply with a short greeting.",
        cwd,
        clientMessageId: "smoke-user-" + generation,
      },
      { ...opt, id: "smoke-run" },
    );
    assert.equal(result.status, "result", JSON.stringify(result));
    const state = JSON.parse(await readFile(join(sessions, "fixture-run", "state.json"), "utf8"));
    assert.equal(state.status, "completed", JSON.stringify({ status: state.status, methods }));
    await core.stopAndWait();
  }
  assert.equal(exposed, false);
  assert.deepEqual(methods, ["sealForFinalization", "sealForFinalization"]);
  console.log(
    "Private ledger smoke passed",
    JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      storage: (await db).mode,
      methods,
    }),
  );
} finally {
  clearTimeout(timeout);
  sessionsByWorker.close();
  host.close();
  await core.stopAndWait();
  await (await db).close();
  await model.close();
}
