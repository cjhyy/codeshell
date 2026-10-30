// Test-owned durable histories only. --import installs the guard before Core.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
assert.ok(globalThis[Symbol.for("codeshell.cost-gui.guard")]);
const { SessionManager } = await import("../../core/dist/session/session-manager.js");
const { SessionOutputJournal } = await import("../../core/dist/session/output-journal.js");
const { outputUserMessage } = await import("../../core/dist/engine/run-output-user-message.js");
const isolated = { codeShellHome: process.env.CODE_SHELL_HOME };
assert.equal(isolated.codeShellHome, join(process.env.HOME, ".code-shell"));
const sessionsRoot = join(isolated.codeShellHome, "sessions");
const target = "synthetic-confirmation-target";
const home = "synthetic-confirmation-home";
const targetTitle = "Synthetic confirmation target";
const cwd = join(isolated.codeShellHome, "no-repo");
await mkdir(cwd, { recursive: true });
const manager = new SessionManager(sessionsRoot);
const now = Date.now();
for (const [id, title] of [
  [home, "Synthetic confirmation home"],
  [target, targetTitle],
]) {
  const bundle = manager.create(cwd, "fixture", "openai", id, null, "desktop");
  const anchor = bundle.transcript.getEvents()[0].id;
  const input = bundle.transcript.appendMessage("user", `OWNED INPUT ${id}`, {
    clientMessageId: `owned-input-${id}`,
  });
  manager.startSessionRun(bundle.state, input.id);
  const journal = new SessionOutputJournal(sessionsRoot, id, input.id, anchor);
  journal.append(outputUserMessage(input.data, id, cwd));
  journal.append({ type: "session_started", sessionId: id, promptTokens: 0 });
  journal.append({ type: "stream_request_start", turnNumber: 1, messageId: `answer-${id}` });
  journal.append({ type: "text_delta", text: `OWNED DURABLE OUTPUT ${id}` });
  journal.append({ type: "turn_complete", reason: "completed" });
  bundle.transcript.appendMessage("assistant", `OWNED DURABLE OUTPUT ${id}`);
  bundle.transcript.appendTurnBoundary();
  bundle.transcript.sync();
  manager.updateSessionState(id, { title, status: "completed" });
}
await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
await writeFile(
  join(isolated.codeShellHome, "settings.json"),
  JSON.stringify({
    autoUpdates: false,
    language: "en",
    externalRuntimes: { enabled: false },
  }),
);
await writeFile(
  join(isolated.codeShellHome, "desktop/session-catalog.json"),
  JSON.stringify({
    version: 1,
    revision: 1,
    indices: {
      __no_repo__: {
        activeSessionId: home,
        sessions: [
          {
            id: home,
            engineSessionId: home,
            title: "Synthetic confirmation home",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: target,
            engineSessionId: target,
            title: targetTitle,
            createdAt: now,
            updatedAt: now - 1,
          },
        ],
      },
    },
    deletedSessionIds: {},
  }),
);
