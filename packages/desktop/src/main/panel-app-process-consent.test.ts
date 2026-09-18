import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PanelAppProcessApprovalStore } from "./panel-app-process-approval-store.js";
import { PanelAppProcessService, type PanelProcessOwner } from "./panel-app-process-service.js";

// Exercise the real Desktop callback wiring without booting Electron. Only the
// native dialog and window lookup are replaced; persistence and process spawning
// use their production implementations in an isolated temporary directory.
const source = await readFile(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
let constructorOptions: ts.Expression | undefined;
function findOptions(node: ts.Node) {
  if (ts.isNewExpression(node) && node.expression.getText(parsed) === "PanelAppProcessService") {
    constructorOptions = node.arguments?.[0];
  }
  ts.forEachChild(node, findOptions);
}
findOptions(parsed);
if (!constructorOptions) throw new Error("Missing Desktop process service options");
const compiled = ts.transpileModule(
  `function optionsForHost() { return ${constructorOptions.getText(parsed)}; }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "panel-process-consent-"));
  const executablePath = join(root, "fixture-tool");
  await writeFile(executablePath, "#!/bin/sh\nprintf 'fixture-ok\\n'\n");
  await chmod(executablePath, 0o700);
  const file = join(root, "approvals.json");
  const decisions: Array<Record<string, any>> = [];
  let response = 0;
  let trusted = true;
  let bound = true;
  const owner: PanelProcessOwner = {
    guestId: 11,
    appId: "download-fixture",
    appTitle: "Download",
    revision: "r1",
    send() {},
  };
  const createService = (identity = owner) => {
    const optionsForHost = runInNewContext(`${compiled}\noptionsForHost`, {
      processApprovalStore: new PanelAppProcessApprovalStore(file),
      panelExecutableDirectories: () => [root],
      app: { getPath: () => root },
      BrowserWindow: { fromId: () => ({ isDestroyed: () => false }) },
      dialog: {
        async showMessageBox(_window: unknown, options: Record<string, any>) {
          decisions.push(options);
          return { response };
        },
      },
    });
    return new PanelAppProcessService(
      optionsForHost.call({
        guests: new Map([
          [
            identity.guestId,
            {
              ownerWindowId: 1,
              guest: { isDestroyed: () => false },
              resource: { descriptor: { appId: identity.appId, revision: identity.revision } },
              projectPath: root,
              cwd: root,
            },
          ],
        ]),
        toolOwners: new Map(),
        options: {
          isPanelAppBound: (projectPath: string, appId: string) =>
            bound && projectPath === root && appId === identity.appId,
          isWorkspaceTrusted: (projectPath: string) => trusted && projectPath === root,
        },
        managedBinDirectory: () => root,
      }),
    );
  };
  const run = async (service: PanelAppProcessService, identity = owner) => {
    const executable = await service.findExecutable(identity, { name: "fixture-tool" });
    const directory = await service.grantDirectory(identity, root);
    let done = () => {};
    const exited = new Promise<void>((resolve) => {
      done = resolve;
    });
    await service.start(
      {
        ...identity,
        send: (event) => {
          if (event === "process.exit") done();
        },
      },
      {
        executableHandle: executable.handle,
        directoryHandle: directory.handle,
        args: [],
      },
    );
    await exited;
  };
  return {
    createService,
    run,
    owner,
    decisions,
    executablePath,
    deny: () => {
      response = 1;
    },
    setTrusted: (value: boolean) => { trusted = value; },
    setBound: (value: boolean) => { bound = value; },
  };
}

describe.skipIf(process.platform === "win32")("Desktop process consent", () => {
  test("installed trusted Panels run without dialogs across app updates and binary changes", async () => {
    const app = await fixture();
    await app.run(app.createService());
    const updated = { ...app.owner, revision: "r2" };
    await app.run(app.createService(updated), updated);
    const anotherApp = { ...updated, appId: "another-app" };
    await app.run(app.createService(anotherApp), anotherApp);
    await writeFile(app.executablePath, "#!/bin/sh\nprintf 'changed-executable-fixture\\n'\n");
    await app.run(app.createService(updated), updated);
    expect(app.decisions).toHaveLength(0);
  });

  test("revoked project trust and app binding still block execution without a dialog", async () => {
    const app = await fixture();
    app.deny();
    const service = app.createService();
    await app.run(service);
    app.setTrusted(false);
    await expect(app.run(service)).rejects.toThrow(/no longer authorized/);
    app.setTrusted(true);
    app.setBound(false);
    await expect(app.run(service)).rejects.toThrow(/no longer authorized/);
    expect(app.decisions).toHaveLength(0);
  });
});
