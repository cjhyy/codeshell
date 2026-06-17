import { describe, test, expect } from "bun:test";
import { bashTool } from "./bash.js";
import { createOffBackend } from "../sandbox/off.js";
import type { ToolContext } from "../context.js";

// Beta cleanup end-to-end: a project's localEnvironment.env (ctx.shellEnv)
// actually reaches a spawned command's environment via the real Bash tool.
// Complements the unit test on mergeShellEnv and the Engine test that the
// context is populated — this proves the whole foreground path works.

function ctx(extra: Partial<ToolContext>): ToolContext {
  // Bash only reads cwd/sandbox/shellEnv/signal; cast the rest.
  return { cwd: process.cwd(), ...extra } as ToolContext;
}

function text(out: string | { result: string }): string {
  return typeof out === "string" ? out : out.result;
}

describe("Bash honors ctx.shellEnv (localEnvironment.env)", () => {
  test("off backend: project env var is visible to the command", async () => {
    const out = await bashTool(
      { command: "echo env=$CODESHELL_TEST_VAR" },
      ctx({ sandbox: createOffBackend(), shellEnv: { CODESHELL_TEST_VAR: "hello-off" } }),
    );
    expect(text(out)).toContain("env=hello-off");
  });

  test("no shellEnv: var is empty (zero regression for projects without env)", async () => {
    const out = await bashTool(
      { command: "echo env=$CODESHELL_TEST_VAR" },
      ctx({ sandbox: createOffBackend() }),
    );
    expect(text(out)).toContain("env=");
    expect(text(out)).not.toContain("hello");
  });

  test("project env can override an inherited value", async () => {
    const out = await bashTool(
      { command: "echo node=$NODE_ENV" },
      ctx({ sandbox: createOffBackend(), shellEnv: { NODE_ENV: "production" } }),
    );
    expect(text(out)).toContain("node=production");
  });

  test("off backend: result carries sandbox mark { backend: 'off' } (UI 显示未隔离)", async () => {
    const out = await bashTool({ command: "echo hi" }, ctx({ sandbox: createOffBackend() }));
    if (typeof out === "string") throw new Error("expected object return");
    expect(out.sandbox).toEqual({ backend: "off" });
  });

  test("backend with network: result carries { backend, network } (UI 显示隔离+网络)", async () => {
    const fakeBackend = {
      name: "seatbelt" as const,
      network: "deny" as const,
      wrap: (command: string, o: { cwd: string; shell: string }) => ({ file: o.shell, args: ["-c", command] }),
    };
    const out = await bashTool({ command: "echo hi" }, ctx({ sandbox: fakeBackend }));
    if (typeof out === "string") throw new Error("expected object return");
    expect(out.sandbox).toEqual({ backend: "seatbelt", network: "deny" });
  });
});
