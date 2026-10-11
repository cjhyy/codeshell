import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Host exit after Panel process close prevents its delayed SIGKILL", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-review-process-close-")));
  let nativePid = 0;
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./hub-native-close-child.ts", import.meta.url))],
      outdir: join(root, "host-build"),
      naming: "host.mjs",
      target: "node",
      format: "esm",
      packages: "external",
    });
    expect(build.success).toBe(true);
    const host = spawn(
      Bun.which("node")!,
      [build.outputs[0]!.path, root, fileURLToPath(new URL("../../../../", import.meta.url))],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    host.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    host.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      host.once("error", reject);
      host.once("close", resolve);
    });
    if (code !== 0) console.log(JSON.stringify({ childFailure: { code, stdout, stderr } }));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout.trim());
    expect(result.hostRuntime).toMatch(/^v\d/);
    expect(result.hostExecutable).toContain("node");
    nativePid = result.nativePid;
    expect(Number.isInteger(nativePid) && nativePid > 1).toBe(true);
    await Bun.sleep(3300);
    let alive = false;
    try {
      process.kill(nativePid, 0);
      alive = true;
    } catch {}
    console.log(
      JSON.stringify({ ...result, hostExitCode: code, nativePid, aliveAfterGraceMs: 3300, alive }),
    );
    expect(alive).toBe(true);
  } finally {
    // Only the exact temporary fixture's detached process group is touched.
    if (!nativePid)
      nativePid =
        JSON.parse(await readFile(join(root, "native-pid.json"), "utf8").catch(() => "{}"))
          .nativePid ?? 0;
    if (nativePid > 1) {
      try {
        process.kill(-nativePid, "SIGKILL");
      } catch {}
    }
    const cleanupDeadline = Date.now() + 2000;
    let remains = nativePid > 1;
    while (Date.now() < cleanupDeadline && remains) {
      try {
        process.kill(nativePid, 0);
      } catch {
        remains = false;
      }
      if (remains) await Bun.sleep(10);
    }
    console.log(JSON.stringify({ fixtureCleanup: { nativePid, gone: !remains } }));
    expect(remains).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
});
