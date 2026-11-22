import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileVersionRead } from "./desktop-host/workspace-reads.js";
import { registerLocalFilePreviewIpc } from "./local-file-preview-ipc.js";

test("single-file preview IPC only accepts a live Desktop main window's main frame", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sender = { mainFrame: {} };
  let live = true;
  registerLocalFilePreviewIpc(
    { handle: (channel, handler) => void handlers.set(channel, handler) },
    (candidate) => live && candidate === (sender as any),
  );
  const exists = handlers.get("fsLocal:exists")!;
  const preview = handlers.get("fsLocal:readPreview")!;
  const root = await mkdtemp(join(tmpdir(), "codeshell-preview-ipc-"));
  const path = join(root, "example.txt");
  await writeFile(path, "example");
  try {
    const main = { sender, senderFrame: sender.mainFrame };
    expect(await exists(main, path)).toBe(true);
    expect(await preview(main, path)).toMatchObject({ text: "example" });

    const other = { mainFrame: {} };
    for (const event of [
      { sender, senderFrame: {} },
      { sender: other, senderFrame: other.mainFrame },
    ]) {
      expect(await exists(event, path)).toBe(false);
      await expect(preview(event, path)).rejects.toThrow("Desktop main window");
    }
    live = false;
    expect(await exists(main, path)).toBe(false);
    await expect(preview(main, path)).rejects.toThrow("Desktop main window");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Host reads versions only within the authorized Session or project root", async () => {
  const reads: string[] = [];
  const [name, route] = fileVersionRead(
    async () => {
      throw Error("An owned session has no historical listing");
    },
    async ({ owner, rootId }) => {
      if (rootId !== "permitted") throw Error("unauthorized");
      const root = "sessionId" in owner ? owner.sessionId : owner.projectId;
      return { path: "/" + root, projectId: "project", revision: 1 };
    },
    async (root) => {
      reads.push(root);
      return { status: "unavailable", reason: "object-missing" };
    },
  );
  expect(name).toBe("files/version");
  const ctx = {
    identity: {
      webContentsId: 1,
      frameGeneration: 1,
      frameToken: "fixture",
      windowKind: "workbench" as const,
    },
    assertCurrent() {},
  };
  const version = async (owner: unknown, rootId = "permitted") =>
    route.run(ctx, { owner, rootId, ref: {} });
  await version({ sessionId: "s-fixture" });
  await version({ projectId: "project" });
  for (const id of ["../bad", "", null]) await expect(version({ sessionId: id })).rejects.toThrow();
  for (const owner of [{ sessionId: "s-fixture" }, { projectId: "project" }])
    await expect(version(owner, "denied")).rejects.toThrow("unauthorized");
  expect(reads).toEqual(["/s-fixture", "/project"]);
});
