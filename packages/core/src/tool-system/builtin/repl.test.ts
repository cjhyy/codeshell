// Direct handler coverage for the REPL tool.
//
// The builtin coverage gate reported REPL as having no direct test, and
// repl.ts measured 0% line coverage — for a tool that spawns child processes
// with user-supplied code. The paths that matter are the ones that decide
// whether a run is reported as success, timeout, abort, or failure.
import { describe, expect, test } from "bun:test";
import { replTool } from "./repl.js";

describe("REPL tool", () => {
  test("runs javascript and returns trimmed stdout", async () => {
    const out = await replTool({ language: "javascript", code: "console.log(1 + 1)" });
    expect(out).toBe("2");
  });

  test("reports a non-zero exit with the program's output", async () => {
    const out = await replTool({
      language: "javascript",
      code: "console.error('boom'); process.exit(3)",
    });
    expect(out).toContain("Error executing javascript");
    expect(out).toContain("boom");
  });

  test("empty code is rejected before spawning anything", async () => {
    expect(await replTool({ language: "javascript", code: "   " })).toBe(
      "Error: no code provided.",
    );
  });

  test("an unsupported language lists the supported ones", async () => {
    const out = await replTool({ language: "brainfuck", code: "+++" });
    expect(out).toContain("Unsupported language: brainfuck");
    expect(out).toContain("javascript");
  });

  test("a run that exceeds its timeout is reported as a timeout, not a failure", async () => {
    const out = await replTool({
      language: "javascript",
      code: "setTimeout(() => {}, 10_000)",
      timeout: 200,
    });
    expect(out).toBe("javascript timed out after 200ms");
  });

  test("a non-positive timeout falls back to the default instead of killing instantly", async () => {
    // `??` only catches null/undefined, so 0 would previously reach setTimeout
    // and clamp to ~0, killing every run on the spot.
    const out = await replTool({ language: "javascript", code: "console.log('ok')", timeout: 0 });
    expect(out).toBe("ok");
  });

  test("an already-aborted signal short-circuits before starting", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await replTool(
      { language: "javascript", code: "console.log('should not run')" },
      { signal: controller.signal } as never,
    );
    expect(out).toBe("javascript aborted before starting.");
  });

  test("aborting mid-run reports an abort rather than a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const out = await replTool(
      { language: "javascript", code: "setTimeout(() => {}, 10_000)", timeout: 30_000 },
      { signal: controller.signal } as never,
    );
    expect(out).toBe("javascript aborted by signal.");
  });

  test("a successful run with no output says so instead of returning empty", async () => {
    expect(await replTool({ language: "javascript", code: "1 + 1" })).toBe("(no output)");
  });

  test("code runs in the context cwd, not the host process cwd", async () => {
    const out = await replTool(
      { language: "javascript", code: "console.log(process.cwd())" },
      { cwd: "/tmp" } as never,
    );
    // macOS resolves /tmp through a symlink, so match the tail.
    expect(out.endsWith("/tmp")).toBe(true);
  });
});
