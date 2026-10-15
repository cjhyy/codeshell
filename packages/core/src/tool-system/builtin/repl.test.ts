// Direct handler coverage for the REPL tool.
//
// The builtin coverage gate reported REPL as having no direct test, and
// repl.ts measured 0% line coverage — for a tool that spawns child processes
// with user-supplied code. The paths that matter are the ones that decide
// whether a run is reported as success, timeout, abort, or failure.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSandboxEnv } from "../../runtime/spawn-common.js";
import { replTool } from "./repl.js";

describe("REPL tool", () => {
  let nodeEntry: string;
  let nodeFixture: string;
  beforeAll(async () => {
    nodeFixture = mkdtempSync(join(tmpdir(), "repl-node-host-"));
    nodeEntry = join(nodeFixture, "repl.mjs");
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "repl.ts")],
      target: "node",
      outdir: nodeFixture,
      naming: "repl.mjs",
    });
    if (!built.success) throw new Error(`Node REPL fixture build failed: ${built.logs.join("\n")}`);
  });
  afterAll(() => rmSync(nodeFixture, { recursive: true, force: true }));

  function runNodeRepl(code: string, cwd: string, shellEnv?: Record<string, string>): string {
    const script = `import { replTool } from ${JSON.stringify(pathToFileURL(nodeEntry).href)};
      console.log(await replTool(${JSON.stringify({ language: "typescript", code })},
        ${JSON.stringify({ cwd, shellEnv })}));`;
    const child = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: nodeFixture,
      env: buildSandboxEnv(),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    return child.stdout.trim();
  }

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
    const out = await replTool({ language: "javascript", code: "console.log('should not run')" }, {
      signal: controller.signal,
    } as never);
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
    const out = await replTool({ language: "javascript", code: "console.log(process.cwd())" }, {
      cwd: "/tmp",
    } as never);
    // macOS resolves /tmp through a symlink, so match the tail.
    expect(out.endsWith("/tmp")).toBe(true);
  });

  test("does not inherit host secrets but keeps PATH and project env", async () => {
    const blocked = [
      "CODESHELL_REPL_PROBE_TOKEN",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "NODE_PATH",
      "PYTHONPATH",
      "VIRTUAL_ENV",
      "CONDA_PREFIX",
    ];
    const previous = new Map(blocked.map((key) => [key, process.env[key]]));
    for (const key of blocked) process.env[key] = "fixture-must-not-inherit";
    try {
      const out = await replTool(
        {
          language: "javascript",
          code: `console.log(JSON.stringify({blocked: ${JSON.stringify(blocked)}.filter(key => process.env[key] !== undefined), path: Boolean(process.env.PATH), project: process.env.PROJECT_FLAG ?? null}))`,
        },
        { shellEnv: { PROJECT_FLAG: "on" } } as any,
      );
      expect(JSON.parse(out)).toEqual({ blocked: [], path: true, project: "on" });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("the spawned process receives the Host write protocol and credential env exposures", async () => {
    const out = await replTool(
      {
        language: "javascript",
        code: "console.log(JSON.stringify({ protocol: process.env.CODESHELL_WORKSPACE_WRITE_PROTOCOL, credential: process.env.PROJECT_CREDENTIAL_TOKEN }))",
      },
      {
        shellEnv: {
          CODESHELL_WORKSPACE_WRITE_PROTOCOL: "unsupported",
          PROJECT_CREDENTIAL_TOKEN: "fixture-credential-exposure",
        },
      } as never,
    );
    expect(JSON.parse(out)).toEqual({
      protocol: "1",
      credential: "fixture-credential-exposure",
    });
  });

  test("Bun-hosted TypeScript uses the host executable even when PATH has no Bun", async () => {
    const out = await replTool(
      {
        language: "typescript",
        code: "const value: string = process.execPath; console.log(value)",
      },
      { shellEnv: { PATH: "/codeshell-fixture-no-runtimes" } } as never,
    );
    expect(out).toBe(process.execPath);
  });

  test("Node-hosted TypeScript requires an installed Bun and reports its absence", () => {
    const out = runNodeRepl("console.log('unreachable')", nodeFixture, {
      PATH: "/codeshell-fixture-no-runtimes",
    });
    expect(out).toContain("Failed to spawn typescript (Bun must be installed and available)");
  });

  test("typescript runtime does not auto-load the cwd .env", async () => {
    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return;
    const dir = mkdtempSync(join(tmpdir(), "repl-dotenv-"));
    try {
      writeFileSync(join(dir, ".env"), "CODESHELL_DOTENV_PROBE=leaked\n");
      const out = await replTool(
        {
          language: "typescript",
          code: "console.log(JSON.stringify(process.env.CODESHELL_DOTENV_PROBE ?? null))",
        },
        { cwd: dir } as never,
      );
      expect(out).toBe("null");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Node-hosted TypeScript uses PATH Bun with --no-env-file", () => {
    const dir = mkdtempSync(join(tmpdir(), "repl-node-dotenv-"));
    try {
      writeFileSync(join(dir, ".env"), "CODESHELL_DOTENV_PROBE=leaked\n");
      const out = runNodeRepl(
        "const value: string = process.env.CODESHELL_DOTENV_PROBE ?? 'clean'; console.log(value)",
        dir,
      );
      expect(out).toBe("clean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
