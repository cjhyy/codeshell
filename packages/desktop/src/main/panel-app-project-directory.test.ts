import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { execFileSync } from "node:child_process";
import {
  createPanelDirectoryProjectScope,
  desktopPanelDirectoryBookmarks,
} from "../../../server/src/panels/directory-bookmarks.js";
import { PanelAppProcessService } from "./panel-app-process-service.js";
import { PanelAppDirectoryBookmarks } from "./panel-app-directory-bookmarks.js";
import { PanelBridgeError } from "../../../server/src/panels/bridge-contract.js";

// Execute the real bridge methods without loading Electron and its application
// startup dependencies. Authorization uses real filesystem paths and the real
// process service; the parsed methods are never reimplemented in the fixture.
const source = await readFile(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const methods = [
  "getKnownProcessDirectory",
  "pickProcessDirectory",
  "restoreProcessDirectory",
  "trustedWorkspaceRoot",
  "directoryProjectScope",
  "assertProjectBinding",
].map((name) => {
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
  root = await realpath(await mkdtemp(join(tmpdir(), "panel-project-directory-")));
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
  const picker = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [join(project, "videos")] }),
  };
  const Bridge = runInNewContext(`${compiled}\nDirectoryBridge`, {
    realpath,
    stat,
    PanelBridgeError,
    createPanelDirectoryProjectScope,
    isPanelAppDescriptorSelected: () => true,
    BrowserWindow: { fromId: () => ({ isDestroyed: () => false }) },
    dialog: picker,
    app: { getPath: () => project },
  });
  const bridge = new Bridge();
  bridge.options = {
    isWorkspaceTrusted: (path: string) => path === project,
    isPanelAppBound: () => true,
  };
  bridge.guests = new Map();
  bridge.processService = service;
  bridge.processOwner = () => owner;
  bridge.directoryBookmarks = new PanelAppDirectoryBookmarks(join(project, "bookmarks.json"));
  const bind = (cwd = project, projectPath = project, appId = owner.appId) => {
    const binding = {
      cwd,
      projectPath,
      ownerWindowId: 1,
      guest: { id: owner.guestId, isDestroyed: () => false },
      resource: { descriptor: { appId, revision: owner.revision } },
    };
    bridge.guests.set(owner.guestId, binding);
    return binding;
  };
  return { bridge, project, service, owner, bind, picker };
}

describe("Panel project process directory", () => {
  test("uses only the trusted bound project and returns an owner-scoped handle", async () => {
    const { bridge, project, service, owner, bind } = await fixture();
    const directory = await bridge.getKnownProcessDirectory(bind(), {
      name: "project",
      path: "/untrusted/override",
    });
    expect(directory.path).toBe(await realpath(project));
    expect(service.directoryPath(owner, directory.handle)).toBe(directory.path);
    expect(() => service.directoryPath({ ...owner, guestId: 12 }, directory.handle)).toThrow();
  });

  test("rejects unbound and untrusted projects without issuing a handle", async () => {
    const { bridge, bind } = await fixture();
    await expect(bridge.getKnownProcessDirectory({}, { name: "project" })).rejects.toThrow(
      /authorization changed/,
    );
    bridge.options.isWorkspaceTrusted = () => false;
    await expect(bridge.getKnownProcessDirectory(bind(), { name: "project" })).rejects.toThrow(
      /authorization changed/,
    );
  });

  test("canonicalizes the bound path and rejects missing roots and ordinary files", async () => {
    const { bridge, project, bind } = await fixture();
    const alias = join(root, "project-alias");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    bridge.options.isWorkspaceTrusted = () => true;
    expect(
      (await bridge.getKnownProcessDirectory(bind(alias, alias), { name: "project" })).path,
    ).toBe(await realpath(project));
    await expect(
      bridge.getKnownProcessDirectory(bind(join(root, "missing")), { name: "project" }),
    ).rejects.toThrow();
    const file = join(root, "file.txt");
    await writeFile(file, "fixture");
    await expect(bridge.getKnownProcessDirectory(bind(file), { name: "project" })).rejects.toThrow(
      /root is unavailable/,
    );
  });

  test("a picked directory renews its grant after a new Panel lifetime without another picker", async () => {
    const { bridge, project, service, owner, bind } = await fixture();
    const videos = join(project, "videos");
    await mkdir(videos);
    const binding = bind();
    const picked = await bridge.pickProcessDirectory(binding);
    expect(typeof picked.bookmark).toBe("string");
    service.revokeGuest(owner.guestId);
    const renewed = await bridge.restoreProcessDirectory(binding, { bookmark: picked.bookmark });
    expect(renewed.handle).not.toBe(picked.handle);
    expect(service.directoryPath(owner, renewed.handle)).toBe(await realpath(videos));
    await expect(
      bridge.restoreProcessDirectory(bind(project, project, "other-app"), {
        bookmark: picked.bookmark,
      }),
    ).rejects.toThrow();
  });

  test("worktree selections share the bound project scope while project handles keep the worktree", async () => {
    const { bridge, project, service, owner, bind, picker } = await fixture();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
    git("init", "-q");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    const worktree = join(root, "worktree");
    git("worktree", "add", "-qb", "directory-test", worktree);
    const output = join(worktree, "output");
    await mkdir(output);
    bridge.options.isWorkspaceTrusted = (path: string) => [project, worktree].includes(path);
    bridge.directoryBookmarks = desktopPanelDirectoryBookmarks(project);
    picker.showOpenDialog = async () => ({ canceled: false, filePaths: [output] });
    const binding = bind(worktree);
    const picked = await bridge.pickProcessDirectory(binding);
    expect(service.directoryPath(owner, picked.handle)).toBe(await realpath(output));
    const known = await bridge.getKnownProcessDirectory(binding, { name: "project" });
    expect(known.path).toBe(await realpath(worktree));
    const downloads = await bridge.getKnownProcessDirectory(binding, { name: "downloads" });
    expect(downloads.path).toBe(await realpath(project));
    const records = JSON.parse(
      await readFile(join(project, "panel-app-directory-bookmarks.json"), "utf8"),
    ).bookmarks;
    expect(records).toHaveLength(3);
    expect(records.every((item: { projectPath: string }) => item.projectPath === project)).toBe(
      true,
    );
    service.revokeGuest(owner.guestId);
    const restored = await bridge.restoreProcessDirectory(bind(), { bookmark: picked.bookmark });
    expect(restored.path).toBe(await realpath(output));
    expect(restored.bookmark).toBe(picked.bookmark);
  });

  for (const change of ["workspace", "revision", "trust", "guest", "destroyed"] as const) {
    test(`a directory picker cannot commit after ${change} changes`, async () => {
      const { bridge, project, service, bind, picker } = await fixture();
      const output = join(project, "videos");
      await mkdir(output);
      const binding = bind();
      let started!: () => void;
      const shown = new Promise<void>((resolve) => (started = resolve));
      let finish!: (value: { canceled: boolean; filePaths: string[] }) => void;
      const selection = new Promise<{ canceled: boolean; filePaths: string[] }>(
        (resolve) => (finish = resolve),
      );
      picker.showOpenDialog = async () => {
        started();
        return selection;
      };
      const pending = bridge.pickProcessDirectory(binding);
      await shown;
      if (change === "workspace") binding.cwd = join(root, "other");
      if (change === "revision") binding.resource.descriptor.revision = "r2";
      if (change === "trust") bridge.options.isWorkspaceTrusted = () => false;
      if (change === "guest") bridge.guests.delete(binding.guest.id);
      if (change === "destroyed") binding.guest.isDestroyed = () => true;
      finish({ canceled: false, filePaths: [output] });
      await expect(pending).rejects.toThrow(/authorization changed/);
      expect((service as unknown as { directories: Map<string, unknown> }).directories.size).toBe(
        0,
      );
      expect(
        await readFile(join(project, "bookmarks.json"), "utf8").catch(
          (error: NodeJS.ErrnoException) => error.code,
        ),
      ).toBe("ENOENT");
    });
  }

  test("a rebind during process authorization cannot allocate a directory handle", async () => {
    const { bridge, project, service, bind } = await fixture();
    const binding = bind();
    (
      service as unknown as { options: { isOwnerAuthorized: () => boolean } }
    ).options.isOwnerAuthorized = () => {
      binding.cwd = join(root, "other");
      return true;
    };
    await expect(bridge.getKnownProcessDirectory(binding, { name: "project" })).rejects.toThrow(
      /authorization changed/,
    );
    expect((service as unknown as { directories: Map<string, unknown> }).directories.size).toBe(0);
    expect(
      await readFile(join(project, "bookmarks.json"), "utf8").catch(
        (error: NodeJS.ErrnoException) => error.code,
      ),
    ).toBe("ENOENT");
  });
});
