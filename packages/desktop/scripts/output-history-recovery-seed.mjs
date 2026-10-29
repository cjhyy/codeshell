// Owned synthetic durable records only; this process starts under the deny-all guard.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../../core/dist/session/session-manager.js";
import { SessionOutputJournal } from "../../core/dist/session/output-journal.js";
import { SessionOutputCoverageStore } from "../../core/dist/session/output-coverage-state.js";
import { outputUserMessage } from "../../core/dist/engine/run-output-user-message.js";

assert.ok(globalThis[Symbol.for("codeshell.cost-gui.guard")]);
const root = process.env.CODE_SHELL_HOME;
assert.equal(root, join(process.env.HOME, ".code-shell"));
const sessionsRoot = join(root, "sessions"),
  id = "owned-output-recovery-session";
const cwd = join(root, "no-repo");
mkdirSync(cwd, { recursive: true });
const manager = new SessionManager(sessionsRoot);
if (process.argv.includes("--append-after-checkpoint")) {
  const existing = manager.resume(id);
  assert.equal(existing.state.outputHistoryRecovery?.historicalGap, true);
  const user = existing.transcript.appendMessage("user", "OWNED NEW SYNTHETIC INPUT", {
    clientMessageId: "owned-new-input",
  });
  manager.startSessionRun(existing.state, user.id);
  const writer = new SessionOutputJournal(sessionsRoot, id, user.id);
  writer.append(outputUserMessage(user.data, id, cwd));
  writer.append({ type: "stream_request_start", turnNumber: 2, messageId: "owned-new-answer" });
  writer.append({ type: "text_delta", text: "OWNED NEW OUTPUT AFTER CHECKPOINT" });
  existing.transcript.appendMessage("assistant", "OWNED NEW OUTPUT AFTER CHECKPOINT");
  existing.transcript.appendTurnBoundary();
  existing.transcript.sync();
  writer.append({ type: "turn_complete", reason: "completed" });
  manager.updateSessionState(id, { status: "completed" });
} else {
  const bundle = manager.create(cwd, "fixture", "codex", id, null, "desktop");
  const base = bundle.transcript.getEvents()[0].id;
  const user = bundle.transcript.appendMessage("user", "OWNED ORIGINAL QUESTION", {
    clientMessageId: "owned-original-input",
  });
  manager.startSessionRun(bundle.state, user.id);
  const writer = new SessionOutputJournal(sessionsRoot, id, user.id, base);
  writer.append(outputUserMessage(user.data, id, cwd));
  writer.append({ type: "session_started", sessionId: id, promptTokens: 0 });
  writer.append({ type: "stream_request_start", turnNumber: 1, messageId: "owned-answer" });
  // Enough independent frames to require multiple production journal pages.
  const text = Array.from(
    { length: 1200 },
    (_, i) => `OWNED ANSWER ${i} ` + "synthetic ".repeat(100),
  ).join("\n");
  // Production fragmentation keeps one large provider delta within frame/page limits.
  writer.append({ type: "text_delta", text: text + "\n" });
  bundle.transcript.appendMessage("assistant", text + "\n");
  bundle.transcript.appendTurnBoundary();
  bundle.transcript.sync();
  const oldCursor = writer.append({ type: "turn_complete", reason: "completed" });
  manager.updateSessionState(id, { status: "completed", title: "Owned history recovery" });
  new SessionOutputCoverageStore(() => sessionsRoot).record(id, { unpaired: true, inputIds: [] });
  const directory = join(sessionsRoot, id);
  writeFileSync(
    join(directory, "external-runtime.json"),
    JSON.stringify({ kind: "codex", runtimeSessionId: "owned-provider-context" }),
    { mode: 0o600 },
  );
  mkdirSync(join(root, "desktop", "transcript-cache"), { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(root, "desktop", "session-catalog.json"),
    JSON.stringify({
      version: 1,
      revision: 1,
      indices: {
        __no_repo__: {
          activeSessionId: id,
          sessions: [
            {
              id,
              engineSessionId: id,
              title: "Owned history recovery",
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      },
      deletedSessionIds: {},
    }),
    { mode: 0o600 },
  );
  const attachment = join(cwd, "held-attachment.txt");
  writeFileSync(attachment, "OWNED ATTACHMENT PRESERVED", { mode: 0o600 });
  const cached = {
    messages: [
      {
        id: "cached-uncertain",
        kind: "user",
        text: "OWNED UNCERTAIN INPUT DO NOT AUTO SEND",
        clientMessageId: "owned-uncertain-input",
        attachments: [
          { path: "held-attachment.txt", absPath: attachment, originalName: "held-attachment.txt" },
        ],
      },
    ],
    sessionId: id,
    snapshotSeq: 0,
    turnEpoch: 0,
    streamingAssistantId: null,
    streamingThinkingId: null,
    activeAgents: {},
    agentMessageIndex: {},
    activeGoal: null,
    promptTokens: 0,
    singleTurnPromptTokens: 0,
    singleTurnCacheReadTokens: 0,
    singleTurnCacheCreationTokens: 0,
    cumulativePromptTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeCacheCreationTokens: 0,
    sessionCacheReadTokens: 0,
    sessionCacheCreationTokens: 0,
    sessionPromptTokens: 0,
  };
  const cacheName =
    createHash("sha256")
      .update(JSON.stringify(["__no_repo__", id]))
      .digest("hex") + ".json";
  writeFileSync(
    join(root, "desktop", "transcript-cache", cacheName),
    JSON.stringify({ version: 1, state: cached }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "settings.json"),
    JSON.stringify({ autoUpdates: false, language: "en", externalRuntimes: { enabled: false } }),
    { mode: 0o600 },
  );
  const hashes = Object.fromEntries(
    ["state.json", "transcript.jsonl", "output-journal.jsonl", "external-runtime.json"].map(
      (name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(directory, name)))
          .digest("hex"),
      ],
    ),
  );
  writeFileSync(
    join(process.env.HOME, "recovery-seed.json"),
    JSON.stringify({ id, directory, cwd, oldCursor, cacheName, attachment, hashes }),
    { mode: 0o600 },
  );
}
