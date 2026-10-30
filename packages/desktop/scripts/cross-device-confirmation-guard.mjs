// Synthetic pending-authority fixture. Main/preload/renderer and journal reads
// remain production code; no tool, credential, provider, or IM work is admitted.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
await import("./output-history-recovery-guard.mjs");

if (process.versions.electron && process.type === "browser") {
  const { BrowserWindow, ipcMain } = await import("electron");
  const pending = new Map();
  const record = (operation, sessionId) =>
    appendFileSync(
      join(process.env.HOME, "confirmation-operations.jsonl"),
      JSON.stringify({ operation, sessionId }) + "\n",
      { mode: 0o600 },
    );
  const send = (method, params) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send("agent:msg", JSON.stringify({ jsonrpc: "2.0", method, params }));
    }
  };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel === "agent:pendingApprovals")
      return handle(channel, () => {
        record(channel);
        return [...pending.values()];
      });
    return handle(channel, (event, ...args) => {
      if (["agent:subscribe", "sessions:outputJournal"].includes(channel)) record(channel, args[0]);
      return listener(event, ...args);
    });
  };
  globalThis.__crossDeviceConfirmationFixture = {
    request(envelope) {
      if (!envelope.requestId.startsWith("synthetic-confirmation-"))
        throw new Error("Only synthetic confirmation identities are allowed");
      pending.set(envelope.requestId, envelope);
      record("request", envelope.sessionId);
      send("agent/approvalRequest", envelope);
    },
    resolve(envelope) {
      if (!pending.delete(envelope.requestId)) throw new Error("Synthetic request is not pending");
      record("resolve", envelope.sessionId);
      send("agent/approvalResolved", envelope);
    },
    size: () => pending.size,
  };
}
