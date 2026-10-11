import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Node worker bridge asynchronous pipe failure is unhandled during exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cs-review-worker-pipe-"));
  let pid = 0;
  try {
    const entry = join(root, "worker.cjs"),
      host = join(root, "host.mjs"),
      pidPath = join(root, "worker-pid.json");
    await writeFile(
      entry,
      `require("node:fs").writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({pid:process.pid}));process.stdin.on("data",()=>process.exit(23));process.stdout.write("ready\\n");`,
    );
    await writeFile(
      host,
      `import { WorkerBridgeCore } from ${JSON.stringify(new URL("../../../../packages/server/dist/worker-bridge-core.js", import.meta.url).href)};
const core = new WorkerBridgeCore({entryPath:${JSON.stringify(entry)},execPath:process.execPath});
await new Promise(resolve=>{core.subscribeLines(line=>{if(line==="ready")resolve();});core.ensureWorker();});
console.log(JSON.stringify({sent:core.sendLine(JSON.stringify({jsonrpc:"2.0",id:1,method:"agent/run",params:{task:"x".repeat(256*1024)}}))}));
await new Promise(resolve=>setTimeout(resolve,200));
console.log("host survived");
`,
    );
    const child = spawn(Bun.which("node")!, [host], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    pid = JSON.parse(await readFile(pidPath, "utf8")).pid;
    console.log(JSON.stringify({ hostExitCode: code, stdout, stderr }));
    expect(code).toBe(1);
    expect(stderr).toContain("EPIPE");
    expect(stdout).not.toContain("host survived");
  } finally {
    if (pid > 1) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});
