import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { SessionCatalogStore } from "./session-catalog-store";
import { SessionTranscriptCache } from "./session-transcript-cache";
import { registerSessionCatalogIpc } from "./session-catalog-ipc";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "codeshell-catalog-ipc-"));
  folders.push(directory);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>();
  const ipc = {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => unknown) =>
      handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const mainFrame = {};
  const broadcasts: unknown[] = [];
  const sent: Array<{ channel: string; value: unknown }> = [];
  const sender = {
    mainFrame,
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => {
      broadcasts.push(value);
      sent.push({ channel, value });
    },
  };
  const window = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow;
  const catalog = new SessionCatalogStore({ file: join(directory, "catalog.json") });
  // These cases exercise the metadata boundary only; no default-path cache IO occurs.
  const transcriptCache = { flush: async () => undefined } as SessionTranscriptCache;
  const registration = registerSessionCatalogIpc(ipc, () => [window], catalog, transcriptCache);
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  return { handlers, event, catalog, broadcasts, sent, registration, directory };
}

test("catalog IPC rejects embedded frames and unregistered windows before reading private data", async () => {
  const { handlers, event } = await setup();
  const load = handlers.get("sessionCatalog:load")!;
  expect(() => load({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow(
    "application window",
  );
  expect(() => load({ ...event, sender: {} } as IpcMainInvokeEvent)).toThrow("application window");
  expect(await load(event)).toEqual({ revision: 0, indices: {} });
});

test("a new row is durable before IPC resolves and broadcasts reach other views", async () => {
  const { handlers, event, broadcasts, registration, directory } = await setup();
  const patch = {
    projectKey: "project.with.dots",
    upserts: [{ id: "session.1", values: { title: "501058", createdAt: 1, updatedAt: 2 } }],
    activeSessionId: "session.1",
  };
  const result = await handlers.get("sessionCatalog:apply")!(event, patch);
  expect(await new SessionCatalogStore({ file: join(directory, "catalog.json") }).load()).toEqual(
    result,
  );
  expect(broadcasts).toEqual([result]);
  registration.dispose();
  expect(handlers.size).toBe(0);
});

test("normal quit waits for the owning renderer to acknowledge queued edits", async () => {
  const { handlers, event, sent, registration } = await setup();
  let completed = false;
  const flushing = registration.flushRenderers().then(() => {
    completed = true;
  });
  const request = sent.find((item) => item.channel === "sessionCatalog:flushRequested");
  expect(request).toBeDefined();
  expect(completed).toBe(false);
  await handlers.get("sessionCatalog:flushComplete")!(event, {
    requestId: request!.value,
    ok: true,
  });
  await flushing;
  expect(completed).toBe(true);
});

test("a renderer save failure rejects normal quit so pending edits remain available", async () => {
  const { handlers, event, sent, registration } = await setup();
  const flushing = registration.flushRenderers();
  const outcome = flushing.then(
    () => null,
    (error: Error) => error,
  );
  const request = sent.find((item) => item.channel === "sessionCatalog:flushRequested")!;
  await handlers.get("sessionCatalog:flushComplete")!(event, {
    requestId: request.value,
    ok: false,
  });
  expect((await outcome)?.message).toContain("could not be saved");
});
