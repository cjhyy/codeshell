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
            projectPath === root && appId === identity.appId,
          isWorkspaceTrusted: (projectPath: string) => projectPath === root,
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
  };
}

describe.skipIf(process.platform === "win32")("Desktop process consent", () => {
  test("Allow and remember survives an app update and Host restart, but not another app or binary", async () => {
    const app = await fixture();
    await app.run(app.createService());
    expect(app.decisions).toHaveLength(1);
    expect(app.decisions[0].buttons[0]).toBe("Allow and remember");
    expect(app.decisions[0].detail).toContain("including after app updates and restarts");
    expect(app.decisions[0].detail).not.toContain("this installed app version");

    const updated = { ...app.owner, revision: "r2" };
    await app.run(app.createService(updated), updated);
    expect(app.decisions).toHaveLength(1);
    const anotherApp = { ...updated, appId: "another-app" };
    await app.run(app.createService(anotherApp), anotherApp);
    expect(app.decisions).toHaveLength(2);
    await writeFile(app.executablePath, "#!/bin/sh\nprintf 'changed-executable-fixture\\n'\n");
    await app.run(app.createService(updated), updated);
    expect(app.decisions).toHaveLength(3);
  });

  test("Cancel never creates a persistent approval", async () => {
    const app = await fixture();
    app.deny();
    await expect(app.run(app.createService())).rejects.toThrow(/denied running/);
    const updated = { ...app.owner, revision: "r2" };
    await expect(app.run(app.createService(updated), updated)).rejects.toThrow(/denied running/);
    expect(app.decisions).toHaveLength(2);
    expect(app.decisions[0].defaultId).toBe(1);
  });
});
