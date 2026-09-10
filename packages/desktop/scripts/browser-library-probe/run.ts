import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Install outside every workspace: never change the application dependency graph or lockfile.
const source = import.meta.dir;
const production = process.argv.includes("--production");
async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let termination: string | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const stop = (reason: string) => {
    if (termination) return;
    termination = reason;
    kill("SIGTERM");
    forceKill = setTimeout(() => kill("SIGKILL"), 2000);
  };
  const interrupt = () => stop("interrupted");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const timer = setTimeout(() => stop(`exceeded ${timeout} ms`), timeout);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (termination) throw new Error(`Probe ${termination}`);
    return code;
  } finally {
    clearTimeout(timer);
    if (forceKill) clearTimeout(forceKill);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    // Also clean up helper processes if the main child has already exited.
    kill("SIGKILL");
  }
}

const stage = await mkdtemp(join(tmpdir(), "codeshell-browser-library-probe-"));
const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
await writeFile(
  join(stage, "package.json"),
  JSON.stringify({ private: true, dependencies: manifest.dependencies }, null, 2),
);
for (const name of production
  ? ["production.cjs"]
  : ["probe.cjs", "electron-debugger-facade.cjs"]) {
  await copyFile(join(source, name), join(stage, name));
}
console.log(`Isolated probe files and dependency lock: ${stage}`);
if (production) {
  const entry = resolve(source, "../../src/main/browser-driver/electron-puppeteer.ts");
  if (
    await run(
      [
        process.execPath,
        "build",
        entry,
        "--target=node",
        "--format=cjs",
        "--outdir",
        stage,
        "--external",
        "electron",
      ],
      stage,
      process.env,
      60_000,
    )
  ) {
    throw new Error("Could not bundle the production Electron adapter");
  }
} else if (
  await run([process.execPath, "install", "--ignore-scripts"], stage, process.env, 120_000)
) {
  throw new Error("Could not install isolated probe dependencies");
}

const requireDesktop = createRequire(resolve(source, "../../package.json"));
const electron = requireDesktop("electron") as string;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
process.exitCode = await run(
  [
    electron,
    join(stage, production ? "production.cjs" : "probe.cjs"),
    ...process.argv.slice(2).filter((arg) => arg !== "--production"),
  ],
  stage,
  env,
  60_000,
);
