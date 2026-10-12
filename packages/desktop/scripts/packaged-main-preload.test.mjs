import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preloadPausedPackagedMain } from "./packaged-main-preload.mjs";

const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
async function fixture(guard, verify, { esm = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "packaged-pause-test-")));
  const entry = join(root, esm ? "entry.mjs" : "entry.cjs");
  const bootstrap = join(root, "guard.cjs");
  const marker = join(root, "entry-result");
  const dependency = join(root, "dependency.mjs");
  const dependencyMarker = join(root, "dependency-result");
  await writeFile(
    bootstrap,
    (esm
      ? `if(require("node:fs").existsSync(${JSON.stringify(dependencyMarker)})) throw Error("dependency body already ran");\n`
      : "") + guard,
  );
  if (esm)
    await writeFile(
      dependency,
      `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(dependencyMarker)}, String(globalThis.__guardInstalled === true));`,
    );
  await writeFile(
    entry,
    esm
      ? `import "./dependency.mjs";import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, String(globalThis.__guardInstalled === true));`
      : `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(globalThis.__guardInstalled === true));`,
  );
  const child = spawn(node, ["--inspect-brk=0", entry], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: root, PATH: process.env.PATH },
  });
  try {
    await verify({ child, bootstrap, entry, marker, dependency, dependencyMarker });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve) => child.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  }
}
test("a real owned Node first-line pause requires the guard before running its entry", async () => {
  await fixture(
    "globalThis.__guardInstalled = true;",
    async ({ child, bootstrap, entry, marker }) => {
      const receipt = await preloadPausedPackagedMain(child, bootstrap, {
        allowedPause: (url) => url === pathToFileURL(entry).href,
        isHostScript: () => false,
      });
      expect(receipt.pid).toBe(child.pid);
      expect(receipt.hostScriptsParsedBeforeGuard).toBe(0);
      await new Promise((resolve) => child.once("exit", resolve));
      expect(child.exitCode).toBe(0);
      expect(await readFile(marker, "utf8")).toBe("true");
    },
  );
});
test("ESM Break-on-start precedes the static dependency body as well as entry", async () => {
  await fixture(
    "globalThis.__guardInstalled = true;",
    async ({ child, bootstrap, dependency, dependencyMarker, marker }) => {
      const receipt = await preloadPausedPackagedMain(child, bootstrap, {
        allowedPause: (url) => url === pathToFileURL(dependency).href,
        isHostScript: (url) => url.endsWith(".mjs"),
        allowParsedHostOnStart: true,
      });
      expect(receipt.firstUserInstruction).toBe(true);
      expect(receipt.hostScriptsParsedBeforeGuard).toBeGreaterThan(0);
      await new Promise((resolve) => child.once("exit", resolve));
      expect(child.exitCode).toBe(0);
      expect(await readFile(dependencyMarker, "utf8")).toBe("true");
      expect(await readFile(marker, "utf8")).toBe("true");
    },
    { esm: true },
  );
});
test("a late or disallowed pause rejects without executing the entry", async () => {
  await fixture("globalThis.__guardInstalled = true;", async ({ child, bootstrap, marker }) => {
    await expect(
      preloadPausedPackagedMain(child, bootstrap, {
        allowedPause: () => false,
        isHostScript: () => false,
      }),
    ).rejects.toThrow("startup barrier failed");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
  });
});
test("a throwing guard rejects without executing the entry", async () => {
  await fixture('throw Error("synthetic guard failed");', async ({ child, bootstrap, marker }) => {
    await expect(
      preloadPausedPackagedMain(child, bootstrap, {
        allowedPause: () => true,
        isHostScript: () => false,
      }),
    ).rejects.toThrow("startup barrier failed");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
  });
});

for (const [name, payload] of [
  ["malformed JSON", "{"],
  ["invalid message shape", "null"],
]) {
  test(`an owned inspector ${name} failure terminates its child before disconnect`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "packaged-malformed-inspector-")));
    const marker = join(root, "events.jsonl");
    const script = join(root, "inspector.cjs");
    // Bun supplies its own `ws` builtin. Resolve the installed implementation
    // under the actual child runtime so its private CJS entry has a real path.
    const ws = execFileSync(node, ["-p", "require.resolve('ws')"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
    }).trim();
    await writeFile(
      script,
      `
      const {WebSocketServer}=require(${JSON.stringify(ws)});
      const fs=require("node:fs");
      let terminating=false;
      const record=event=>fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({event})+"\\n");
      process.on("SIGTERM",()=>{terminating=true;record("term");setTimeout(()=>process.exit(0),25);});
      const server=new WebSocketServer({host:"127.0.0.1",port:0});
      server.on("listening",()=>console.error("Debugger listening on ws://127.0.0.1:"+server.address().port+"/owned-inspector"));
      server.on("connection",socket=>{
        socket.once("message",()=>socket.send(${JSON.stringify(payload)}));
        socket.on("close",()=>{if(!terminating) record("disconnected-before-term");});
      });
    `,
    );
    const child = spawn(node, [script], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: root, PATH: process.env.PATH },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    try {
      await expect(
        preloadPausedPackagedMain(child, join(root, "unused.cjs"), {
          allowedPause: () => true,
          isHostScript: () => false,
        }),
      ).rejects.toThrow("startup barrier failed");
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      const events = (
        await readFile(marker, "utf8").catch((error) => {
          throw new Error(`owned inspector fixture failed: ${stderr}`, { cause: error });
        })
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      expect(events).toEqual([{ event: "term" }]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once("exit", resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}
