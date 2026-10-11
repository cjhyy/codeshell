import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../scripts/bun-test-completion.mjs";

test("Main names an extensionless redirect from its final response, not its requested endpoint", async () => {
  const root = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "collection-main-url-")));
  const environment = createBunTestEnvironment(process.env, join(directory, "isolation"));
  // The parent never imports Core or Main. A fresh Bun process installs its
  // transport guard and proof spy before Main can bind either package alias.
  const child = spawn(
    process.execPath,
    [join(root, "tests/fixtures/collection-main-url-document-types.fixture.mjs"), root, directory],
    { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let closed = false;
  let timedOut = false;
  let spawnError: Error | undefined;
  let cleanupError: string | undefined;
  let result: { code: number | null; signal: string | null } | undefined;
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.once("error", (error) => (spawnError = error));
  const completed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          timedOut = true;
          reject(new Error("Main URL fixture exceeded 15s"));
        }, 15_000);
      }),
    ]);
    if (spawnError) throw spawnError;
    expect(result).toEqual({ code: 0, signal: null });
    const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
    expect(receipt).toMatchObject({
      valid: true,
      pid: child.pid,
      ppid: process.pid,
      downloads: 2,
      unexpectedNetworkAttempts: 0,
      identityPreserved: true,
    });
    expect(receipt.home).toBe(environment.HOME);
    const guard = JSON.parse(readFileSync(join(directory, "before-core.json"), "utf8"));
    expect(guard.phase).toBe("before-first-Core-import");
    expect(guard.negativeProbes).toBe(guard.expectedProbes);
    expect(guard.negativeProbes).toBeGreaterThan(20);
  } finally {
    clearTimeout(deadline);
    if (!closed) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch (error) {
        cleanupError = String(error);
      }
      let closeDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          completed,
          new Promise<never>((_, reject) => {
            closeDeadline = setTimeout(
              () => reject(new Error("Main URL child did not close")),
              2_000,
            );
          }),
        ]);
      } catch (error) {
        cleanupError = String(error);
      } finally {
        clearTimeout(closeDeadline);
      }
    }
    writeFileSync(join(directory, "stdout.log"), stdout, { mode: 0o600 });
    writeFileSync(join(directory, "stderr.log"), stderr, { mode: 0o600 });
    writeFileSync(
      join(directory, "launcher.json"),
      JSON.stringify(
        {
          pid: child.pid,
          parentPid: process.pid,
          result,
          closed,
          timedOut,
          cleanupUnknown: !closed,
          cleanupError,
          spawnError: spawnError?.message,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log("Main URL naming evidence: " + directory);
  }
}, 20_000);
