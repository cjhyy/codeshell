import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { ActivityHistoryWorker } from "./activity-history-worker-client.js";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FileHistory, SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { turnUndoState } from "./file-history-service";
import { getSessionEvents } from "./rawTranscript";
import { getSessionTranscript } from "./transcript-reader";

describe("desktop cold session paths honor CODE_SHELL_HOME", () => {
  let previousCodeShellHome: string | undefined;
  let codeShellHome: string;
  let cwd: string;
  let sessionId: string;
  let legacySessionDir: string;

  beforeEach(() => {
    previousCodeShellHome = process.env.CODE_SHELL_HOME;
    codeShellHome = mkdtempSync(join(tmpdir(), "desktop-cold-session-home-"));
    cwd = join(codeShellHome, "project");
    mkdirSync(cwd);
    process.env.CODE_SHELL_HOME = codeShellHome;
    sessionId = `cold-home-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    legacySessionDir = join(homedir(), ".code-shell", "sessions", sessionId);
  });

  afterEach(() => {
    if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousCodeShellHome;
    rmSync(codeShellHome, { recursive: true, force: true });
    rmSync(legacySessionDir, { recursive: true, force: true });
  });

  test("file history rejects traversal-like session ids", () => {
    expect(turnUndoState("..")).toEqual({ undoable: false, redoable: false, fileCount: 0 });
    expect(turnUndoState("session..other")).toEqual({
      undoable: false,
      redoable: false,
      fileCount: 0,
    });
  });

  test("the history worker claims a live permit under the undo/redo lock", async () => {
    const root = sessionsRoot();
    const changed = join(cwd, "worker-change.txt");
    writeFileSync(changed, "before");
    const history = new FileHistory(join(root, sessionId));
    history.saveSnapshot(changed, 1);
    writeFileSync(changed, "after");
    const worker = new ActivityHistoryWorker({ sessionsDir: root });
    const permit = () => new Int32Array(new SharedArrayBuffer(4));
    try {
      const revoked = permit();
      Atomics.store(revoked, 0, -1);
      await assert.rejects(worker.turnHistory({ sessionId, action: "undo" }, revoked), /revoked/);
      expect(readFileSync(changed, "utf8")).toBe("after");
      await worker.turnHistory({ sessionId, action: "undo" }, permit());
      expect(readFileSync(changed, "utf8")).toBe("before");
      expect(await worker.turnHistory({ sessionId, action: "state" }, permit())).toEqual({
        undoable: false, redoable: true, fileCount: 1,
      });
      await assert.rejects(worker.turnHistory({ sessionId, action: "redo" }, revoked), /revoked/);
      expect(readFileSync(changed, "utf8")).toBe("before");
      await worker.turnHistory({ sessionId, action: "redo" }, permit());
      expect(readFileSync(changed, "utf8")).toBe("after");
    } finally {
      await worker.close();
    }
  });

  test("cold transcript, raw replay, and desktop undo use the canonical sessions root", async () => {
    const manager = new SessionManager();
    const session = manager.create(cwd, "model", "provider", sessionId, null, "desktop");
    session.transcript.appendMessage("user", "message from configured home");

    const replay = await getSessionTranscript(sessionId);
    expect(replay).toContainEqual(
      expect.objectContaining({ kind: "user", text: "message from configured home" }),
    );
    const raw = await getSessionEvents(sessionId);
    expect(raw.some((event) => event.data.content === "message from configured home")).toBe(true);

    const changedFile = join(cwd, "changed.txt");
    writeFileSync(changedFile, "before");
    const history = new FileHistory(join(sessionsRoot(), sessionId));
    history.saveSnapshot(changedFile, 1);
    expect(turnUndoState(sessionId)).toEqual({ undoable: true, redoable: false, fileCount: 1 });

    expect(existsSync(legacySessionDir)).toBe(false);
  });
});
