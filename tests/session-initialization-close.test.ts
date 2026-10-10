import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../scripts/bun-test-completion.mjs";

const cases = [
  ["engine-dispose", "Engine dispose cancels pending Session service initialization"],
  ["runtime-close", "Runtime close cancels pending Session service initialization"],
  [
    "chat-busy-close",
    "ChatSessionManager busy close cancels pending Session service initialization",
  ],
  ["active-run-control", "active run keeps initialized Session services until settlement"],
] as const;

// This fixture replaces built-in HTTP exports. Its fresh process and HOME use
// the same guard as run-bun-test-shard; retain its JUnit document for exact-case
// verification and local red/green evidence instead of deleting the report.
test("actual Session initialization close acceptance in a private guarded process", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-session-close-evidence-")));
  const report = join(directory, "junit.xml");
  const environment = createBunTestEnvironment(process.env, join(directory, "isolation"));
  const child = spawn(
    process.execPath,
    [
      "test",
      "--timeout",
      "5000",
      "./tests/fixtures/session-initialization-close.fixture.ts",
      "--reporter",
      "junit",
      "--reporter-outfile",
      report,
    ],
    {
      cwd: root,
      env: {
        ...environment,
        CODESHELL_SESSION_INITIALIZATION_EVIDENCE_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let finished = false;
  const completed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        finished = true;
        resolve({ code, signal });
      });
    },
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Session initialization fixture exceeded its 20s total deadline")),
          20_000,
        );
      }),
    ]);
    const xml = readFileSync(report, "utf8");
    const actualNames = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(actualNames.sort()).toEqual(cases.map(([, name]) => name).sort());
    const preimport = JSON.parse(readFileSync(join(directory, "preimport-guard.json"), "utf8"));
    const homeId = createHash("sha256").update(environment.HOME).digest("hex");
    expect(preimport.phase).toBe("before-Core-import");
    expect(preimport.guard.pid).toBe(child.pid);
    expect(preimport.guard.homeId).toBe(homeId);
    expect(preimport.guard.negativeProbes).toBe(8);
    expect(environment.HOME).not.toBe(process.env.HOME);
    // Retain the exact completed case inventory for red runs as well as green.
    writeFileSync(
      join(directory, "execution.json"),
      JSON.stringify({ result, actualNames, homeId, fixturePid: child.pid }, null, 2) + "\n",
      { mode: 0o600 },
    );
    expect(result).toEqual({ code: 0, signal: null });
    expect(assertBunTestCompletion(report)).toEqual({ tests: cases.length, skipped: 0 });
    for (const [id, name] of cases) {
      const receipt = JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
      expect(receipt.name).toBe(name);
      expect(receipt.outcome).toBe("passed");
      expect(receipt.guard.pid).toBe(child.pid);
      expect(receipt.guard.homeId).toBe(homeId);
      expect(receipt.deniedRequestsAfterProbes).toBe(0);
      expect(receipt.after.status).toBe("aborted_streaming");
      expect(receipt.releasedA).toBe(1);
      expect(receipt.releasedB).toBe(1);
      expect(receipt.calls).toBe(id === "active-run-control" ? 1 : 0);
      expect(receipt.cleanupErrors).toEqual([]);
    }
    writeFileSync(
      join(directory, "completion.json"),
      JSON.stringify({ result, actualNames, homeId, fixturePid: child.pid }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } finally {
    clearTimeout(deadline);
    if (!finished && child.pid) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          env: environment,
          stdio: "ignore",
          timeout: 3_000,
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* This wrapper's own child group already exited. */
        }
      }
      let reapingDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          completed.catch(() => {}),
          new Promise((resolve) => {
            reapingDeadline = setTimeout(resolve, 1_000);
          }),
        ]);
      } finally {
        clearTimeout(reapingDeadline);
      }
    }
    writeFileSync(join(directory, "child.log"), output, { mode: 0o600 });
    console.log(`Session initialization close evidence: ${directory}`);
    console.log(output);
  }
}, 30_000);
