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

  beforeEach(() => {
    // Isolate the user home so we never read the dev's real ~/.code-shell.
    home = mkdtempSync(join(tmpdir(), "shellenv-home-"));
    process.env.CODE_SHELL_HOME = home;
    proj = mkdtempSync(join(tmpdir(), "shellenv-proj-"));
  });

  afterEach(() => {
    delete process.env.CODE_SHELL_HOME;
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
});
