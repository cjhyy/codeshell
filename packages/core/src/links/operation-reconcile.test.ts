import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBunTestEnvironment,
  assertBunTestCompletion,
} from "../../../../scripts/bun-test-completion.mjs";

if (process.env.CODESHELL_OPERATION_READ_CHILD === "1") {
  // This branch is entered only by the private child below. The fixture starts
  // its exact-origin guard before its first Core import; the parent never does.
  await import("../../tests/operation-reconcile.fixture.ts");
} else {
  test("independent confined HTTP suite completes its own full JUnit report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codeshell-operation-read-child-"));
    const reports = mkdtempSync(join(tmpdir(), "codeshell-operation-read-reports-"));
    const report = join(directory, "child.junit.xml");
    const guard = join(directory, "child-guard.json");
    const executable = realpathSync(process.execPath);
    const file = fileURLToPath(import.meta.url);
    let child;
    let timer;
    try {
      child = spawn(
        executable,
        ["test", "--timeout", "30000", file, "--reporter", "junit", "--reporter-outfile", report],
        {
          env: {
            ...createBunTestEnvironment(process.env, directory),
            CODESHELL_OPERATION_READ_CHILD: "1",
            CODESHELL_OPERATION_READ_RECEIPT: guard,
          },
          stdio: "inherit",
        },
      );
      timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve(signal ?? code));
      });
      expect(code).toBe(0);
      const receipt = JSON.parse(readFileSync(guard, "utf8"));
      expect(receipt.pid).toBe(child.pid);
      expect(receipt.ppid).toBe(process.pid);
      expect(receipt.executable).toBe(executable);
      expect(receipt.executableSha256).toBe(
        createHash("sha256").update(readFileSync(executable)).digest("hex"),
      );
      expect(receipt.home).toBe(realpathSync(join(directory, "home")));
      expect(receipt.version).toBe(process.version);
      expect(receipt.bun).toBe(process.versions.bun);
      expect(receipt.negativeProbes).toBe(8);
      expect(receipt.negativeProbeNames).toEqual([
        "fetch",
        "dispatcher",
        "http.request",
        "http.named.request",
        "http.named.get",
        "https.named.request",
        "https.named.get",
        "socketPath",
      ]);
      expect(receipt.confinement).toBe(
        "Bun JavaScript fetch/http/https exits; not an OS or native network sandbox",
      );
      expect(receipt.preservesBuiltinExports).toBe(true);
      expect(receipt.allowedHttpProbe).toBe(true);
      expect(receipt.beforeCoreImport).toBe(true);
      expect(receipt.fixtureSha256).toBe(
        createHash("sha256")
          .update(
            readFileSync(
              fileURLToPath(new URL("../../tests/operation-reconcile.fixture.ts", import.meta.url)),
            ),
          )
          .digest("hex"),
      );
      const allowed = new URL(receipt.origin);
      expect(allowed.protocol).toBe("http:");
      expect(allowed.hostname).toBe("127.0.0.1");
      expect(Number(allowed.port)).toBeGreaterThan(0);
      const summary = assertBunTestCompletion(report);
      expect(summary.tests).toBe(28);
      expect(summary.skipped).toBe(0);
      const retained = join(reports, "child.junit.xml");
      copyFileSync(report, retained);
      copyFileSync(guard, join(reports, "child-guard.json"));
      console.log(
        `Independent HTTP JUnit: ${summary.tests} tests, 0 failures; executable ${executable}; report ${retained}`,
      );
    } finally {
      clearTimeout(timer);
      if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
      // Only the bounded JUnit evidence is retained, not the child's HOME/state.
    }
  }, 30_000);
}
