import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { ModelTraceStore, type ModelTraceRecord } from "@cjhyy/code-shell-core/internal";
import { createTraceHistoryService } from "./trace-history-service.js";
import { registerModelTraceIpc } from "./model-trace-ipc.js";
import { createModelTraceApi } from "../preload/model-trace-api.js";

const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-trace-ipc-"));
  directories.push(root);
  const store = new ModelTraceStore({ storageDir: join(root, ".model-traces") });
  store.write({
    version: 1,
    id: "record-1",
    traceId: "run-1",
    sessionId: "session-1",
    source: "fixture",
    purpose: "main",
    provider: "fixture",
    model: "fixture",
    startedAt: Date.now(),
    status: "completed",
    stream: false,
    inputState: "not-recorded",
    outputState: "not-recorded",
    attempts: [],
  } satisfies ModelTraceRecord);
  store.writeEvent({
    id: "event-1",
    traceId: "run-1",
    kind: "tool",
    name: "Read",
    startedAt: Date.now(),
    status: "completed",
    inputState: "not-recorded",
    outputState: "not-recorded",
  });
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>();
  const sender = { mainFrame: {} };
  const window = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow;
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent;
  const registration = registerModelTraceIpc(
    {
      handle: (name, callback) => {
        handlers.set(name, callback);
      },
      removeHandler: (name) => {
        handlers.delete(name);
      },
    },
    () => [window],
    createTraceHistoryService({ store, storageDir: store.storageDir }),
  );
  const api = createModelTraceApi({
    invoke: async (name, input) => handlers.get(name)!(event, input),
  });
  return { api, store, event, handlers, registration };
}

test("production preload methods reach the validated native trace service and persist policy independently of dev mode", async () => {
  const f = fixture();
  expect((await f.api.list()).items.map((record) => record.id)).toEqual(["record-1"]);
  const detail = await f.api.get("record-1");
  expect(detail?.record.sessionId).toBe("session-1");
  expect(detail?.events.map((event) => event.id)).toEqual(["event-1"]);
  expect(await f.api.get("missing")).toBeNull();
  expect(await f.api.setConfig({ captureContent: true, includeEphemeral: true })).toMatchObject({
    enabled: true,
    captureContent: true,
    includeEphemeral: true,
    retentionDays: 7,
  });
  expect(new ModelTraceStore({ storageDir: f.store.storageDir }).getConfig().captureContent).toBe(
    true,
  );
  await expect(f.api.list({ storageDir: "/foreign" } as any)).rejects.toThrow(
    "Unknown model trace query field",
  );
  await expect(f.api.get("../secret")).rejects.toThrow("Invalid model trace id");
  f.registration.dispose();
  expect(f.handlers.size).toBe(0);
});

test("embedded frames and unrelated windows cannot inspect prompts or change capture settings", () => {
  const f = fixture();
  const original = f.store.getConfig();
  for (const channel of f.handlers.keys()) {
    expect(() =>
      f.handlers.get(channel)!({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, {}),
    ).toThrow("application window");
    expect(() =>
      f.handlers.get(channel)!(
        { ...f.event, sender: { mainFrame: f.event.senderFrame } } as unknown as IpcMainInvokeEvent,
        {},
      ),
    ).toThrow("application window");
  }
  expect(f.store.getConfig()).toEqual(original);
});
