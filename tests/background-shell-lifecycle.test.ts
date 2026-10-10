import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../scripts/bun-test-completion.mjs";

function nodeExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const path = join(directory, "node");
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return realpathSync(path);
    } catch {
      /* Search the original PATH; never download a runtime. */
    }
  }
  throw new Error("Background shell acceptance requires actual Node");
}

// POSIX executable permissions and inherited pipes are exercised with real
// shells. Portable manager tests continue to cover the other supported hosts.
test.skipIf(process.platform === "win32")(
  "actual Bash background lifecycle in private Node",
  async () => {
    const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
    const cache = join(root, "node_modules/.cache/background-shell-lifecycle");
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const directory = realpathSync(mkdtempSync(join(cache, "run-")));
    const entry = join(directory, "entry.ts");
    writeFileSync(
      entry,
      [
        `export { BackgroundShellManager } from ${JSON.stringify(join(root, "packages/core/src/runtime/background-shell.ts"))};`,
        `export { bashTool } from ${JSON.stringify(join(root, "packages/core/src/tool-system/builtin/bash.ts"))};`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const built = await Bun.build({
      entrypoints: [entry],
      outdir: join(directory, "build"),
      target: "node",
      format: "esm",
      sourcemap: "external",
      tsconfig: join(root, "tsconfig.json"),
      // Core's NodeNext .js specifiers refer to source .ts in this fixture.
      // Resolve the real file without replacing any production module.
      plugins: [
        {
          name: "core-source-specifiers",
          setup(build) {
            build.onResolve({ filter: /^\..*\.js$/ }, (args) => {
              const source = resolve(args.resolveDir, args.path.slice(0, -3) + ".ts");
              if (existsSync(source)) return { path: source };
            });
          },
        },
      ],
    });
    expect(built.success).toBe(true);
    const bundle = join(directory, "build/entry.js");
    expect(statSync(bundle).size).toBeGreaterThan(0);
    const node = nodeExecutable();
    const fixture = join(root, "tests/fixtures/background-shell-lifecycle.fixture.mjs");
    const environment = {
      ...createBunTestEnvironment(process.env, join(directory, "isolation")),
      CODESHELL_BG_LIFECYCLE_ROOT: root,
      CODESHELL_BG_LIFECYCLE_EVIDENCE: directory,
      CODESHELL_BG_LIFECYCLE_BUNDLE: bundle,
    };
    const report = join(directory, "junit.xml");
    const child = spawn(
      node,
      [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=junit",
        "--test-reporter-destination=" + report,
        fixture,
      ],
      { cwd: root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let closed = false;
    let spawnError: Error | undefined;
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => (spawnError = error));
    const completed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: { code: number | null; signal: string | null } | undefined;
    let cleanupUnknown = false;
    let cooperativeRequested = false;
    let cooperativeConfirmed = false;
    try {
      result = await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Background lifecycle fixture exceeded 20s")),
            20_000,
          );
        }),
      ]);
      if (spawnError) throw spawnError;
      expect(result).toEqual({ code: 0, signal: null });
      const xml = readFileSync(report, "utf8");
      expect(xml).toMatch(/<\/testsuites>\s*$/);
      expect(xml).not.toMatch(/<!DOCTYPE|<!ENTITY|<(?:failure|error|skipped)\b/);
      expect([...xml.matchAll(/<testcase\b/g)]).toHaveLength(8);
      const guard = JSON.parse(readFileSync(join(directory, "before-core.json"), "utf8"));
      expect(guard.ppid).toBe(child.pid);
      expect(guard.negativeProbes).toBe(8);
      expect(guard.homeSha256).toBe(createHash("sha256").update(environment.HOME).digest("hex"));
      const completion = JSON.parse(readFileSync(join(directory, "completion.json"), "utf8"));
      expect(completion).toMatchObject({
        tests: 8,
        passed: 8,
        failed: 0,
        unexpectedNetworkCalls: 0,
      });
      expect(completion.children.every((receipt: { closed: boolean }) => receipt.closed)).toBe(
        true,
      );
    } finally {
      clearTimeout(timer);
      if (!closed && child.pid) {
        cooperativeRequested = true;
        // Detached background shells belong to the fixture, not this group.
        // Ask their live owner to close them before stopping the Node runner.
        try {
          writeFileSync(join(directory, "inherited-pipe-release"), "release", { mode: 0o600 });
          writeFileSync(join(directory, "shutdown.request"), "shutdown", { mode: 0o600 });
        } catch {
          cleanupUnknown = true;
        }
        let cooperativeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            completed,
            new Promise<never>((_, reject) => {
              cooperativeTimer = setTimeout(
                () => reject(new Error("Fixture did not shut down")),
                5_000,
              );
            }),
          ]);
        } catch {
          cleanupUnknown = true;
        } finally {
          clearTimeout(cooperativeTimer);
        }
      }
      if (!closed && child.pid) {
        // The fallback owns only Node's group. It cannot attest descendant
        // cleanup; never signal detached groups by a historical PID.
        cleanupUnknown = true;
        try {
          if (child.exitCode === null && child.signalCode === null) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupUnknown = true;
        }
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            completed,
            new Promise<never>((_, reject) => {
              closeTimer = setTimeout(() => reject(new Error("Node did not close")), 2_000);
            }),
          ]);
        } catch {
          cleanupUnknown = true;
        } finally {
          clearTimeout(closeTimer);
        }
      }
      try {
        const shutdown = JSON.parse(readFileSync(join(directory, "shutdown.json"), "utf8"));
        cooperativeConfirmed =
          shutdown.complete === true &&
          shutdown.errors.length === 0 &&
          shutdown.children.every((receipt: { closed: boolean }) => receipt.closed);
      } catch {
        /* No proof means unknown, even if the Node runner closed. */
      }
      cleanupUnknown ||= !cooperativeConfirmed;
      writeFileSync(join(directory, "stdout.log"), stdout, { mode: 0o600 });
      writeFileSync(join(directory, "stderr.log"), stderr, { mode: 0o600 });
      writeFileSync(
        join(directory, "launcher.json"),
        JSON.stringify(
          {
            node,
            parentPid: process.pid,
            childPid: child.pid,
            result,
            closed,
            cleanupUnknown,
            cooperativeRequested,
            cooperativeConfirmed,
            spawnError: spawnError?.message,
            bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
            fixtureSha256: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log("Background lifecycle Node evidence: " + directory);
    }
    if (cleanupUnknown) throw new Error("Owned Node cleanup is unknown");
  },
  30_000,
);
