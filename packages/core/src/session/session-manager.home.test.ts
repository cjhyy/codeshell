/**
 * Regression: tests (and any host) must be able to redirect the default
 * sessions dir away from ~/.code-shell via CODE_SHELL_HOME — otherwise unit
 * tests that `new Engine()` / `new SessionManager()` with no explicit
 * storageDir write real session dirs into the user's ~/.code-shell/sessions,
 * polluting the desktop sidebar (the rm-usage/test-model junk). Mirrors Codex's
 * CODEX_HOME isolation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager — CODE_SHELL_HOME isolation", () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "csh-"));
    prev = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  test("default sessions dir lives under CODE_SHELL_HOME, not ~/.code-shell", () => {
    const sm = new SessionManager(); // no explicit storageDir
    sm.create("/tmp", "m", "p", "sess-x");
    // The session must be written under our temp home, never the real home.
    expect(existsSync(join(home, "sessions", "sess-x", "state.json"))).toBe(true);
  });

  test("explicit storageDir still wins over the env", () => {
    const explicit = mkdtempSync(join(tmpdir(), "csh-explicit-"));
    const sm = new SessionManager(join(explicit, "sessions"));
    sm.create("/tmp", "m", "p", "sess-y");
    expect(existsSync(join(explicit, "sessions", "sess-y", "state.json"))).toBe(true);
    rmSync(explicit, { recursive: true, force: true });
  });
});

/**
 * The preload in bunfig.toml only applies when Bun resolves a bunfig — running
 * `bun test <file>` from a subdirectory, or an IDE/CI runner that sets its own
 * cwd, finds none. Verified: from packages/desktop/src/main a plain
 * `bun test external-runtime-service.test.ts` wrote two fixture sessions into
 * the developer's real ~/.code-shell/sessions. Config cannot be the only guard,
 * so codeShellHome() itself must refuse the real home under a test runner.
 */
describe("sessionsRoot — refuses the real sessions store under a test runner", () => {
  let prevHome: string | undefined;
  let prevNodeEnv: string | undefined;
  beforeEach(() => {
    prevHome = process.env.CODE_SHELL_HOME;
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.CODE_SHELL_HOME;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevHome;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  test("throws instead of silently writing to ~/.code-shell/sessions", async () => {
    process.env.NODE_ENV = "test";
    const prevSandbox = process.env.CODE_SHELL_TEST_HOME;
    delete process.env.CODE_SHELL_TEST_HOME;
    try {
      const { sessionsRoot } = await import("./session-manager.js");
      // Must name the env var so the failure is self-explanatory.
      expect(() => sessionsRoot()).toThrow(/CODE_SHELL_HOME/);
    } finally {
      if (prevSandbox !== undefined) process.env.CODE_SHELL_TEST_HOME = prevSandbox;
    }
  });

  test("an explicit home is always honoured, real or not", async () => {
    process.env.NODE_ENV = "test";
    const { sessionsRoot } = await import("./session-manager.js");
    const explicit = mkdtempSync(join(tmpdir(), "csh-explicit-home-"));
    try {
      expect(sessionsRoot(explicit)).toBe(join(explicit, "sessions"));
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  });

  test("the home itself stays readable — only the sessions root is guarded", async () => {
    // settings / projects / trust legitimately resolve the real home in tests.
    process.env.NODE_ENV = "test";
    const { codeShellHome } = await import("./session-manager.js");
    expect(codeShellHome()).toContain(".code-shell");
  });

  test("falls back to the preload sandbox when a test deleted CODE_SHELL_HOME", async () => {
    // 49 test files delete this var in cleanup, and bun shares one process
    // across files, so later suites would otherwise lose their isolation.
    process.env.NODE_ENV = "test";
    const sandbox = mkdtempSync(join(tmpdir(), "csh-sandbox-"));
    const prevSandbox = process.env.CODE_SHELL_TEST_HOME;
    process.env.CODE_SHELL_TEST_HOME = sandbox;
    try {
      const { sessionsRoot } = await import("./session-manager.js");
      expect(sessionsRoot()).toBe(join(sandbox, "sessions"));
    } finally {
      if (prevSandbox === undefined) delete process.env.CODE_SHELL_TEST_HOME;
      else process.env.CODE_SHELL_TEST_HOME = prevSandbox;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("a real host run still resolves the real sessions store", async () => {
    process.env.NODE_ENV = "production";
    const { sessionsRoot } = await import("./session-manager.js");
    expect(sessionsRoot()).toContain(".code-shell");
  });
});
