import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";

const baseLlm = { provider: "openai", model: "gpt-5", apiKey: "test-key" } as any;

/**
 * Beta cleanup: localEnvironment.env wiring. Engine.buildToolContext() must
 * surface the project's `.code-shell/settings.json` localEnvironment.env as
 * ctx.shellEnv so the Bash tool / background shells can layer it onto the
 * spawn env (mergeShellEnv). Sub-agents and no-env projects get undefined.
 */
describe("Engine shellEnv (localEnvironment.env wiring)", () => {
  let home: string;
  let proj: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Isolate the user home so we never read the dev's real ~/.code-shell.
    // SettingsManager.userHome() reads $HOME, so override that (not just
    // CODE_SHELL_HOME, which only some subsystems honor) — otherwise the
    // global-env tests would read the developer's real settings.
    home = mkdtempSync(join(tmpdir(), "shellenv-home-"));
    process.env.CODE_SHELL_HOME = home;
    prevHome = process.env.HOME;
    process.env.HOME = home;
    proj = mkdtempSync(join(tmpdir(), "shellenv-proj-"));
  });

  afterEach(() => {
    delete process.env.CODE_SHELL_HOME;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  function writeProjectEnv(env: Record<string, string>): void {
    mkdirSync(join(proj, ".code-shell"), { recursive: true });
    writeFileSync(
      join(proj, ".code-shell", "settings.json"),
      JSON.stringify({ localEnvironment: { env } }),
    );
  }

  function writeProjectSettings(settings: Record<string, unknown>): void {
    mkdirSync(join(proj, ".code-shell"), { recursive: true });
    writeFileSync(join(proj, ".code-shell", "settings.json"), JSON.stringify(settings));
  }

  function writeGlobalSettings(settings: Record<string, unknown>): void {
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(join(home, ".code-shell", "settings.json"), JSON.stringify(settings));
  }

  it("surfaces project localEnvironment.env on the tool context", () => {
    writeProjectEnv({ DATABASE_URL: "postgres://local", NODE_ENV: "test" });
    const engine = new Engine({ llm: baseLlm, cwd: proj });
    const ctx = engine.buildToolContext();
    expect(ctx.shellEnv).toEqual({ DATABASE_URL: "postgres://local", NODE_ENV: "test" });
  });

  it("is undefined when the project configures no env", () => {
    const engine = new Engine({ llm: baseLlm, cwd: proj });
    expect(engine.buildToolContext().shellEnv).toBeUndefined();
  });

  it("is undefined for sub-agents (minimal surface)", () => {
    writeProjectEnv({ SECRET_THING: "x" });
    const engine = new Engine({ llm: baseLlm, cwd: proj, isSubAgent: true } as any);
    expect(engine.buildToolContext().shellEnv).toBeUndefined();
  });

  it("is undefined with no cwd", () => {
    const engine = new Engine({ llm: baseLlm });
    expect(engine.buildToolContext().shellEnv).toBeUndefined();
  });

  // ── Top-level `env` field (CC-style): global + project, layered on top of
  // localEnvironment.env. Priority (lowest → highest):
  //   project localEnvironment.env  →  global env  →  project env
  // All three are user-configured, so none is filtered through the deny regex
  // (that machinery only guards host process.env passthrough). API keys like
  // OPENAI_API_KEY live in the global `env` so one config serves every project.

  // Global env lives in the host ~/.code-shell, so the Engine must read the
  // user layer — that requires settingsScope: "full" (the default "project"
  // scope deliberately never reads the host user dir; see SettingsScope).
  const full = { settingsScope: "full" } as const;

  it("surfaces global top-level env", () => {
    writeGlobalSettings({ env: { OPENAI_API_KEY: "sk-global" } });
    const engine = new Engine({ llm: baseLlm, cwd: proj, ...full } as any);
    expect(engine.buildToolContext().shellEnv).toEqual({ OPENAI_API_KEY: "sk-global" });
  });

  it("project top-level env wins over global top-level env", () => {
    writeGlobalSettings({ env: { OPENAI_API_KEY: "sk-global", SHARED: "g" } });
    writeProjectSettings({ env: { OPENAI_API_KEY: "sk-project" } });
    const engine = new Engine({ llm: baseLlm, cwd: proj, ...full } as any);
    expect(engine.buildToolContext().shellEnv).toEqual({
      SHARED: "g",
      OPENAI_API_KEY: "sk-project",
    });
  });

  it("top-level env wins over localEnvironment.env (localEnvironment is the floor)", () => {
    writeGlobalSettings({ env: { TOKEN_X: "from-global-env" } });
    writeProjectSettings({
      env: { TOKEN_X: "from-project-env" },
      localEnvironment: { env: { TOKEN_X: "from-local-env", DATABASE_URL: "postgres://local" } },
    });
    const engine = new Engine({ llm: baseLlm, cwd: proj, ...full } as any);
    // localEnvironment floor (DATABASE_URL survives), TOKEN_X overridden by
    // project top-level env (which itself beats global env).
    expect(engine.buildToolContext().shellEnv).toEqual({
      DATABASE_URL: "postgres://local",
      TOKEN_X: "from-project-env",
    });
  });

  it("merges all three layers by precedence", () => {
    writeGlobalSettings({ env: { GLOBAL_ONLY: "g", OVERLAP: "g" } });
    writeProjectSettings({
      env: { PROJECT_ONLY: "p", OVERLAP: "p" },
      localEnvironment: { env: { LOCAL_ONLY: "l", OVERLAP: "l" } },
    });
    const engine = new Engine({ llm: baseLlm, cwd: proj, ...full } as any);
    expect(engine.buildToolContext().shellEnv).toEqual({
      LOCAL_ONLY: "l",
      GLOBAL_ONLY: "g",
      PROJECT_ONLY: "p",
      OVERLAP: "p", // project top-level env is highest priority
    });
  });

  it("global env applies even when project configures nothing", () => {
    writeGlobalSettings({ env: { OPENAI_API_KEY: "sk-global" } });
    const proj2 = mkdtempSync(join(tmpdir(), "shellenv-proj2-"));
    const engine = new Engine({ llm: baseLlm, cwd: proj2, ...full } as any);
    expect(engine.buildToolContext().shellEnv).toEqual({ OPENAI_API_KEY: "sk-global" });
    rmSync(proj2, { recursive: true, force: true });
  });

  it("is undefined for sub-agents even with global env (minimal surface)", () => {
    writeGlobalSettings({ env: { OPENAI_API_KEY: "sk-global" } });
    const engine = new Engine({ llm: baseLlm, cwd: proj, isSubAgent: true, ...full } as any);
    expect(engine.buildToolContext().shellEnv).toBeUndefined();
  });

  it("does NOT read global env under default (project) scope — host isolation", () => {
    // The SDK-embedding safety contract: a project-scoped engine must never
    // surface the host user's ~/.code-shell global env.
    writeGlobalSettings({ env: { OPENAI_API_KEY: "sk-global" } });
    const engine = new Engine({ llm: baseLlm, cwd: proj });
    expect(engine.buildToolContext().shellEnv).toBeUndefined();
  });
});
