import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PanelAppProcessService } from "./panel-app-process-service.js";

// Execute the real bridge methods without loading Electron and its application
// startup dependencies. Authorization uses real filesystem paths and the real
// process service; the parsed methods are never reimplemented in the fixture.
const source = await readFile(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const methods = ["getKnownProcessDirectory", "trustedWorkspaceRoot"].map((name) => {
  const method = declaration.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name,
  );
  if (!method) throw new Error(`Missing bridge method: ${name}`);
  return method.getText(parsed);
});
const compiled = ts.transpileModule(`class DirectoryBridge { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "panel-project-directory-"));
  const project = join(root, "project");
  await mkdir(project);
  const service = new PanelAppProcessService({ confirmExecution: async () => true });
  const owner = {
    guestId: 11,
    appId: "download-test",
    appTitle: "Download",
    revision: "r1",
    send() {},
  };
  const Bridge = runInNewContext(`${compiled}\nDirectoryBridge`, { realpath, stat });
  const bridge = new Bridge();
  bridge.options = { isWorkspaceTrusted: (path: string) => path === project };
  bridge.processService = service;
  bridge.processOwner = () => owner;
  return { bridge, project, service, owner };
}

describe("Panel project process directory", () => {
  test("uses only the trusted bound project and returns an owner-scoped handle", async () => {
    const { bridge, project, service, owner } = await fixture();
    const directory = await bridge.getKnownProcessDirectory(
      { cwd: project },
      { name: "project", path: "/untrusted/override" },
    );
    expect(directory.path).toBe(await realpath(project));
    expect(service.directoryPath(owner, directory.handle)).toBe(directory.path);
    expect(() => service.directoryPath({ ...owner, guestId: 12 }, directory.handle)).toThrow();
  });

  test("rejects unbound and untrusted projects without issuing a handle", async () => {
    const { bridge, project } = await fixture();
    await expect(bridge.getKnownProcessDirectory({}, { name: "project" })).rejects.toThrow(
      /trusted workspace/,
    );
    bridge.options.isWorkspaceTrusted = () => false;
    await expect(
      bridge.getKnownProcessDirectory({ cwd: project }, { name: "project" }),
    ).rejects.toThrow(/trusted workspace/);
  });

  test("canonicalizes the bound path and rejects missing roots and ordinary files", async () => {
    const { bridge, project } = await fixture();
    const alias = join(root, "project-alias");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    bridge.options.isWorkspaceTrusted = () => true;
    expect((await bridge.getKnownProcessDirectory({ cwd: alias }, { name: "project" })).path).toBe(
      await realpath(project),
    );
    await expect(
      bridge.getKnownProcessDirectory({ cwd: join(root, "missing") }, { name: "project" }),
    ).rejects.toThrow();
    const file = join(root, "file.txt");
    await writeFile(file, "fixture");
    await expect(
      bridge.getKnownProcessDirectory({ cwd: file }, { name: "project" }),
    ).rejects.toThrow(/root is unavailable/);
  });
});
