import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
