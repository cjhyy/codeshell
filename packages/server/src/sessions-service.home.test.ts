import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { cleanupStaleQuickChatSessions, deleteSession, listDiskSessions } from "./sessions-service";

describe("desktop session services CODE_SHELL_HOME routing", () => {
  let previousHome: string | undefined;
  let codeShellHome: string;
  let cwd: string;

  beforeEach(() => {
    previousHome = process.env.CODE_SHELL_HOME;
    codeShellHome = mkdtempSync(join(tmpdir(), "desktop-session-home-"));
    cwd = join(codeShellHome, "project");
    mkdirSync(cwd);
    process.env.CODE_SHELL_HOME = codeShellHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousHome;
    rmSync(codeShellHome, { recursive: true, force: true });
  });

  test("core create and desktop list/delete/startup GC share the configured sessions root", async () => {
    const manager = new SessionManager();
    manager.create(cwd, "model", "provider", "normal-in-custom-home", null, "desktop");
    manager.create(cwd, "model", "provider", "qchat-in-custom-home", null, "desktop");

    expect(sessionsRoot()).toBe(join(codeShellHome, "sessions"));
    expect((await listDiskSessions({ limit: 10 })).sessions.map((session) => session.id)).toEqual([
      "normal-in-custom-home",
    ]);

    await deleteSession("normal-in-custom-home");
    expect(existsSync(join(sessionsRoot(), "normal-in-custom-home"))).toBe(false);

    expect(await cleanupStaleQuickChatSessions()).toEqual(["qchat-in-custom-home"]);
    expect(existsSync(join(sessionsRoot(), "qchat-in-custom-home"))).toBe(false);
  });
});
