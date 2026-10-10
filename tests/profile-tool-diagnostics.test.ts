import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../scripts/bun-test-completion.mjs";

const caseNames = [
  "does not treat a failed CLI's high-version stderr as satisfying the minimum",
  "reports successful CLI output without a version as unconfirmed",
  "preserves low-version diagnostics from a successful CLI",
  "accepts a successful CLI that meets the minimum",
  "reports an actual startup failure rather than a missing command",
  "reports the real ten-second probe timeout without trusting earlier output",
];

function nodeExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "node");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // Keep searching the caller's original PATH; never download or use Bun.
    }
  }
  throw new Error("An actual Node executable is required for the CLI probe fixture");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

// POSIX scripts exercise the real Main probe. Windows keeps the portable
// planner/formatter/confirmation tests, without claiming a native CLI result.
test.skipIf(process.platform === "win32")(
  "actual Profile tool diagnostics in a private guarded Node process",
  async () => {
    const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
    const cache = join(root, "node_modules", ".cache", "profile-tool-diagnostics");
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const directory = realpathSync(mkdtempSync(join(cache, "run-")));
    const bin = join(directory, "bin");
    mkdirSync(bin, { mode: 0o700 });
    const node = nodeExecutable();
    const environment = {
      ...createBunTestEnvironment(process.env, join(directory, "isolation")),
      PATH: bin,
      CODESHELL_PROFILE_TOOL_EVIDENCE: directory,
      CODESHELL_PROFILE_TOOL_ROOT: root,
      CODESHELL_PROFILE_TOOL_NODE: node,
      CODESHELL_PROFILE_TOOL_BUNDLE: join(directory, "build", "profiles-service.mjs"),
    };
    const report = join(directory, "junit.xml");
    const tsconfig = join(directory, "tsconfig.json");
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: "ES2022" } }), {
      mode: 0o600,
    });
    let child: ReturnType<typeof spawn> | undefined;
    let closed = false;
    let spawnError: Error | undefined;
    let completed: Promise<{ code: number | null; signal: string | null }> | undefined;
    let result: { code: number | null; signal: string | null } | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let bundleSha256: string | undefined;
    let stdout = "";
    let stderr = "";
    try {
      // Root builds Core first. The tiny tsconfig avoids bundling its source
      // through workspace paths; Node resolves the external package in this tree.
      expect(statSync(join(root, "packages/core/dist/index.js")).size).toBeGreaterThan(0);
      expect(statSync(join(root, "packages/core/dist/index.internal.js")).size).toBeGreaterThan(0);
      const built = await Bun.build({
        entrypoints: [join(root, "packages/desktop/src/main/profiles-service.ts")],
        outdir: join(directory, "build"),
        naming: "profiles-service.mjs",
        target: "node",
        format: "esm",
        packages: "external",
        external: ["@cjhyy/code-shell-core", "@cjhyy/code-shell-core/internal"],
        sourcemap: "external",
        tsconfig,
      });
      expect(built.success).toBe(true);
      const bundle = readFileSync(environment.CODESHELL_PROFILE_TOOL_BUNDLE);
      expect(bundle.length).toBeGreaterThan(0);
      bundleSha256 = createHash("sha256").update(bundle).digest("hex");
      child = spawn(
        node,
        [
          "--test",
          "--test-concurrency=1",
          "--test-reporter=junit",
          "--test-reporter-destination=" + report,
          join(root, "tests/fixtures/profile-tool-diagnostics.fixture.mjs"),
        ],
        { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true },
      );
      child.stdout!.on("data", (chunk) => (stdout += chunk));
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      child.once("error", (error) => (spawnError = error));
      completed = new Promise((resolve) => {
        child!.once("close", (code, signal) => {
          closed = true;
          resolve({ code, signal });
        });
      });
      result = await Promise.race([
        completed,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Node CLI fixture exceeded its 35s total deadline")),
            35_000,
          );
        }),
      ]);
      if (spawnError) throw spawnError;
      const xml = readFileSync(report, "utf8");
      expect(Buffer.byteLength(xml)).toBeLessThan(2 * 1024 * 1024);
      expect(xml).not.toMatch(/<!DOCTYPE|<!ENTITY/);
      expect(xml).toMatch(/<\/testsuites>\s*$/);
      const names = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"/g)].map((match) =>
        decodeXml(match[1]),
      );
      const guard = JSON.parse(readFileSync(join(directory, "before-core.json"), "utf8"));
      const completion = JSON.parse(readFileSync(join(directory, "completion.json"), "utf8"));
      writeFileSync(
        join(directory, "execution.json"),
        JSON.stringify({ result, bundleSha256, names, guard, completion }, null, 2),
        { mode: 0o600 },
      );
      expect(result).toEqual({ code: 0, signal: null });
      expect(xml).not.toMatch(/<(?:failure|error|skipped)\b/);
      expect(names).toEqual(caseNames);
      expect(guard.phase).toBe("before-first-Core-import");
      // Node's test launcher creates the actual fixture process.
      expect(guard.ppid).toBe(child.pid);
      expect(guard.negativeProbes).toBe(8);
      expect(guard.homeSha256).toBe(createHash("sha256").update(environment.HOME).digest("hex"));
      expect(completion).toMatchObject({ tests: 6, passed: 6, failed: 0, unexpectedDenials: 0 });
      for (let index = 0; index < caseNames.length; index++) {
        const receipt = JSON.parse(
          readFileSync(join(directory, "case-" + index + ".json"), "utf8"),
        );
        expect(receipt).toMatchObject({
          name: caseNames[index],
          outcome: "passed",
          pid: guard.pid,
          homeSha256: guard.homeSha256,
          unexpectedDenials: 0,
        });
      }
    } finally {
      clearTimeout(deadline);
      let cleanupUnknown = false;
      if (child && !closed && child.pid) {
        // This still-live handle owns the detached group, including a blocked
        // spawnSync probe. Never look up or signal a historical PID.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            completed!,
            new Promise<never>((_resolve, reject) => {
              cleanupDeadline = setTimeout(
                () => reject(new Error("Node group did not close")),
                5_000,
              );
            }),
          ]);
        } catch {
          cleanupUnknown = true;
        } finally {
          clearTimeout(cleanupDeadline);
        }
      }
      writeFileSync(join(directory, "stdout.log"), stdout, { mode: 0o600 });
      writeFileSync(join(directory, "stderr.log"), stderr, { mode: 0o600 });
      writeFileSync(
        join(directory, "launcher-close.json"),
        JSON.stringify(
          {
            launcherPid: child?.pid,
            parentPid: process.pid,
            result,
            closed,
            cleanupUnknown,
            spawnError: spawnError?.message,
            bundleSha256,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log("Profile tool Node evidence: " + directory);
      if (cleanupUnknown) throw new Error("Owned Node process group cleanup is unknown");
    }
  },
  45_000,
);
