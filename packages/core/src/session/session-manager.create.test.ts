import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { SessionError } from "../exceptions.js";

describe("SessionManager.create", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-create-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("explicit session id reuse fails instead of mixing state with an old transcript", () => {
    const sm = new SessionManager(dir);
    const first = sm.create("/tmp/old", "m", "p", "same-id");
    first.transcript.appendMessage("user", "old transcript");

    expect(() => sm.create("/tmp/new", "m", "p", "same-id")).toThrow(SessionError);

    const resumed = sm.resume("same-id");
    expect(resumed.state.cwd).toBe("/tmp/old");
    expect(resumed.transcript.toMessages().some((m) => m.role === "user")).toBe(true);
  });

  test("list preview skips injected user-role transcript messages", () => {
    const sm = new SessionManager(dir);
    const session = sm.create("/tmp/proj", "m", "p", "with-injected");
    session.transcript.appendMessage("user", "real user request");
    session.transcript.appendMessage("assistant", "ok");
    session.transcript.appendMessage("user", "synthetic background reminder", { injected: true });

    expect(sm.list(1)[0]?.preview).toBe("real user request");
  });
});
