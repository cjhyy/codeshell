import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../context.js";
import { createOffBackend } from "../sandbox/off.js";
import { bashTool } from "./bash.js";

describe("Bash command exit diagnostics", () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "bash-exit-diagnostics-"));
    ctx = { cwd, sandbox: createOffBackend() } as ToolContext;
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  test("silent exit 1 stays a failure with a conditional explanation", async () => {
    const result = await bashTool({ command: "exit 1" }, ctx);

    expect(result).toMatchObject({ ok: false, exitCode: 1, stderr: "" });
    if (typeof result === "string" || result.ok) throw new Error("expected command failure");
    expect(result.error).toContain("Exit code: 1 (command failed)");
    expect(result.error).toContain("(command produced no output)");
    expect(result.error).toContain('can mean "no matches"');
    expect(result.error).toContain("or a command error");
    expect(result.error).not.toContain("command completed");
  });

  test("a successful silent command has no failure diagnostic", async () => {
    expect(await bashTool({ command: "exit 0" }, ctx)).toMatchObject({
      ok: true,
      result: "(command produced no output)",
    });
  });

  test("stderr from a real command failure is preserved without a no-match hint", async () => {
    // A fixed child argv avoids shell-specific stderr redirection syntax.
    ctx.sandbox = {
      ...createOffBackend(),
      wrap: () => ({
        file: process.execPath,
        args: ["-e", "process.stderr.write('denied'); process.exit(1)"],
      }),
    };
    const result = await bashTool({ command: "stderr-fixture" }, ctx);

    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    if (typeof result === "string" || result.ok) throw new Error("expected command failure");
    expect(result.stderr).toContain("denied");
    expect(result.error).toContain("STDERR:");
    expect(result.error).not.toContain("no matches");
  });

  test("other nonzero statuses remain failures without a no-match hint", async () => {
    const result = await bashTool({ command: "exit 7" }, ctx);

    expect(result).toMatchObject({ ok: false, exitCode: 7 });
    if (typeof result === "string" || result.ok) throw new Error("expected command failure");
    expect(result.error).toContain("Exit code: 7 (command failed)");
    expect(result.error).not.toContain("no matches");
  });

  test.skipIf(process.platform === "win32")(
    "a failing query preserves earlier mutations and prevents later && steps",
    async () => {
      const result = await bashTool(
        {
          command:
            "echo saved > earlier.txt && echo checked && test -f absent.txt && echo unsafe > later.txt",
        },
        ctx,
      );

      expect(result).toMatchObject({ ok: false, exitCode: 1, stderr: "" });
      if (typeof result === "string" || result.ok) throw new Error("expected command failure");
      expect(result.error).toContain("checked");
      expect(result.error).toContain('can mean "no matches"');
      expect(readFileSync(join(cwd, "earlier.txt"), "utf8")).toBe("saved\n");
      expect(() => readFileSync(join(cwd, "later.txt"))).toThrow();
    },
  );

  test.skipIf(process.platform === "win32")(
    "an explicit query conditional accepts no matches and preserves actual errors",
    async () => {
      writeFileSync(join(cwd, "input.txt"), "haystack\n");
      const query = (path: string) =>
        `if grep -q needle ${path}; then echo found; else query_status=$?; ` +
        'if [ "$query_status" -eq 1 ]; then echo no-match; else exit "$query_status"; fi; fi';

      const noMatch = await bashTool({ command: query("input.txt") }, ctx);
      expect(noMatch).toMatchObject({ ok: true, result: "no-match\n" });
      expect(await bashTool({ command: query("missing.txt") }, ctx)).toMatchObject({
        ok: false,
        exitCode: 2,
      });
    },
  );
});
