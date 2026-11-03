import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFileVersionIpc } from "./file-version-ipc.js";
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

test("version IPC uses Session/project root authority and rejects invalid Session ids", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: unknown[][] = [];
  registerFileVersionIpc(
    { handle: (name, handler) => void handlers.set(name, handler) },
    {
      requireSessionRoot: async (sessionId, rootId) => {
        calls.push(["session", sessionId, rootId]);
        if (rootId === "denied") throw Error("unauthorized");
        return "/session-root";
      },
      requireProjectRoot: async (projectId, rootId) => {
        calls.push(["project", projectId, rootId]);
        if (rootId === "denied") throw Error("unauthorized");
        return { path: "/project-root" };
      },
      readVersion: async (root, ref) => {
        calls.push(["read", root, ref]);
        return { status: "unavailable", reason: "object-missing" };
      },
    },
  );
  const ref = { example: true };
  await handlers.get("fsSession:readFileVersion")!({}, "s-fixture", "root", ref);
  await handlers.get("fsRoot:readFileVersion")!({}, "project", "root", ref);
  expect(calls).toEqual([
    ["session", "s-fixture", "root"],
    ["read", "/session-root", ref],
    ["project", "project", "root"],
    ["read", "/project-root", ref],
  ]);
  for (const id of ["../bad", "", null])
    await expect(handlers.get("fsSession:readFileVersion")!({}, id, "root", ref)).rejects.toThrow();
  await expect(
    handlers.get("fsSession:readFileVersion")!({}, "s-fixture", "denied", ref),
  ).rejects.toThrow("unauthorized");
  await expect(
    handlers.get("fsRoot:readFileVersion")!({}, "project", "denied", ref),
  ).rejects.toThrow("unauthorized");
  expect(calls.filter((c) => c[0] === "read")).toHaveLength(2);
});
