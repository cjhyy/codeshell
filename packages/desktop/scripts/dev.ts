/**
 * Dev orchestrator — runs three concurrent things:
 *
 *   1. vite dev server on http://localhost:5173 (renderer with HMR)
 *   2. esbuild watch on src/main/index.ts → out/main/index.cjs
 *   3. esbuild watch on src/preload/index.ts → out/preload/index.cjs
 *
 * Once 1+2+3 have all produced first output, we spawn `electron .` with
 * VITE_DEV_URL set so main loads the dev server URL. On main code
 * changes we restart electron (preload changes require renderer reload
 * — done via vite HMR client refresh on preload).
 *
 * Intentionally no concurrently/chokidar dep — esbuild's watch API and
 * vite's programmatic API give us everything.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createViteServer } from "vite";
import esbuild from "esbuild";
import { resolve } from "node:path";

const cwd = resolve(import.meta.dir);
const root = resolve(cwd, "..");

const VITE_URL = "http://localhost:5173";

async function startVite(): Promise<void> {
  const server = await createViteServer({
    configFile: resolve(root, "vite.config.ts"),
  });
  await server.listen(5173);
  // eslint-disable-next-line no-console
  console.log(`[dev] vite dev server: ${VITE_URL}`);
}

let electronProc: ChildProcess | null = null;

function spawnElectron(): void {
  if (electronProc) {
    electronProc.removeAllListeners();
    electronProc.kill("SIGTERM");
  }
  electronProc = spawn("electron", ["."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_URL: VITE_URL },
  });
  electronProc.on("exit", (code) => {
    // eslint-disable-next-line no-console
    console.log(`[dev] electron exited (${code}); quitting orchestrator`);
    process.exit(code ?? 0);
  });
}

async function buildAndWatch(): Promise<void> {
  let mainBuilt = false;
  let preloadBuilt = false;

  const tryLaunch = (): void => {
    if (mainBuilt && preloadBuilt && !electronProc) {
      spawnElectron();
    }
  };

  const mainCtx = await esbuild.context({
    entryPoints: [resolve(root, "src/main/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: resolve(root, "out/main/index.mjs"),
    external: ["electron"],
    loader: { ".md": "text" },
    sourcemap: "inline",
    logLevel: "info",
    // node CJS deps (anything not converted to ESM) need a `require` shim
    // when imported from an .mjs file. esbuild bundles them inline but
    // their internal `require(...)` calls expect the symbol to exist.
    banner: {
      js: "import { createRequire as __ccr } from 'node:module'; const require = __ccr(import.meta.url);",
    },
    plugins: [
      {
        name: "main-rebuild",
        setup(build) {
          build.onEnd(() => {
            mainBuilt = true;
            if (electronProc) {
              // eslint-disable-next-line no-console
              console.log("[dev] main rebuilt → restarting electron");
              spawnElectron();
            } else {
              tryLaunch();
            }
          });
        },
      },
    ],
  });
  await mainCtx.watch();

  const preloadCtx = await esbuild.context({
    entryPoints: [resolve(root, "src/preload/index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: resolve(root, "out/preload/index.cjs"),
    external: ["electron"],
    sourcemap: "inline",
    logLevel: "info",
    plugins: [
      {
        name: "preload-rebuild",
        setup(build) {
          build.onEnd(() => {
            preloadBuilt = true;
            tryLaunch();
          });
        },
      },
    ],
  });
  await preloadCtx.watch();
}

async function main(): Promise<void> {
  await startVite();
  await buildAndWatch();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[dev] orchestrator failed:", err);
  process.exit(1);
});
