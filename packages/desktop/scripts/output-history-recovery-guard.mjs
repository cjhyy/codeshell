// Test-only first-instruction guard. Recovery IPC remains the production handler.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
await import("./runtime-cost-gui-guard.mjs");

const file = join(process.env.HOME, "recovery-operations.jsonl");
const record = (kind, operation) =>
  appendFileSync(file, JSON.stringify({ pid: process.pid, kind, operation }) + "\n", {
    mode: 0o600,
  });
if (process.versions.electron && process.type === "browser") {
  const { app, ipcMain, safeStorage } = await import("electron");
  for (const method of ["encryptString", "decryptString"]) {
    safeStorage[method] = () => {
      record("forbidden", "secretStorage");
      throw Error("History recovery acceptance never accesses secret storage");
    };
  }
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, async (event, ...args) => {
      if (
        [
          "externalRuntime:start",
          "externalRuntime:send",
          "externalRuntime:approvalDecision",
        ].includes(channel)
      ) {
        record("forbidden", channel);
        throw Error("History recovery acceptance never submits provider work");
      }
      if (
        [
          "sessions:outputRecoveryPlan",
          "sessions:outputRecoveryApply",
          "sessions:outputJournal",
          "agent:subscribe",
        ].includes(channel)
      )
        record("ipc", channel);
      return listener(event, ...args);
    });
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, listener) =>
    on(channel, (event, ...args) => {
      if (channel === "agent:msg") {
        const method = JSON.parse(args[0]).method;
        if (["agent/run", "agent/steer", "agent/approve", "agent/answer"].includes(method)) {
          record("forbidden", method);
          throw Error("History recovery acceptance never submits worker work");
        }
      }
      return listener(event, ...args);
    });
  app.on("web-contents-created", (_event, contents) => {
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      const blocked = /^https?:|^wss?:/.test(details.url);
      if (blocked) record("blocked-network", "renderer");
      callback({ cancel: blocked });
    });
  });
  record("guard", "main-ready");
}
