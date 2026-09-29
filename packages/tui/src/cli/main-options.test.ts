import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("interactive command options", () => {
  test("keeps resume and prefill available on both interactive entry points", () => {
    const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
    const helpFor = (args: string[]) =>
      spawnSync(process.execPath, [entrypoint, ...args, "--help"], {
        encoding: "utf-8",
        timeout: 10_000,
      });
    const root = helpFor([]);
    const repl = helpFor(["repl"]);

    expect(root.status).toBe(0);
    expect(repl.status).toBe(0);
    for (const result of [root, repl]) {
      expect(result.stdout).toContain("--resume <sessionId>");
      expect(result.stdout).toContain("--prefill <text>");
    }
  });

  test("does not advertise or accept the retired Arena subcommand", () => {
    const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
    const help = spawnSync(process.execPath, [entrypoint, "--help"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).not.toMatch(/\barena\b/i);

    const retired = spawnSync(process.execPath, [entrypoint, "arena", "review changes"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(retired.status).toBe(1);
    expect(retired.stderr).toContain("too many arguments");
  });
});
