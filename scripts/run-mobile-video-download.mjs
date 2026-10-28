/* Usage: node scripts/run-isolated-node-smoke.mjs scripts/run-mobile-video-download.mjs
 * /absolute/path/to/codeshell-panel-apps/apps/video-download */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { join, resolve } from "node:path";

assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
assert.ok(!process.versions.bun, "Run the consumer with Node's production process/HTTP semantics");
assert.ok(process.argv[2], "Pass the read-only apps/video-download package directory");
const root = resolve(import.meta.dirname, "..");
const { build } = createRequire(join(root, "packages/desktop/package.json"))("esbuild");
const directory = await mkdtemp(join(root, "node_modules/.cache-video-consumer-node-"));
try {
  await build({
    entryPoints: [join(root, "scripts/smoke-mobile-video-download.mjs")],
    outdir: directory,
    entryNames: "consumer",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    // Keep the Core/Panel HTTP dynamic imports behind the exact-origin guard.
    splitting: true,
    platform: "node",
    format: "esm",
    tsconfigRaw: {},
    plugins: [
      {
        name: "installed-package-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (
              args.pluginData?.resolving ||
              args.path.startsWith("node:") ||
              builtinModules.includes(args.path)
            )
              return;
            const result = await builder.resolve(args.path, {
              resolveDir: args.resolveDir,
              kind: args.kind,
              pluginData: { resolving: true },
            });
            if (result.errors.length) return { errors: result.errors };
            return { path: result.path, external: true };
          });
        },
      },
    ],
    target: "node22",
    logLevel: "warning",
  });
  const bootstrap = join(directory, "bootstrap.mjs");
  // TrustedDeviceStore itself imports Core's file lock. Deny all HTTP before
  // even that import; the consumer synchronously replaces this with its exact
  // loopback guard once the fixture server has acquired a port.
  await writeFile(
    bootstrap,
    `import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
const originalFetch=globalThis.fetch;
const saved=[http,https].map(module=>({module,request:module.request,get:module.get}));
const deny=()=>{throw Error('Consumer network requested before fixture guard')};
globalThis.fetch=deny;for(const {module} of saved) {module.request=deny;module.get=deny;}
syncBuiltinESMExports();
globalThis[Symbol.for('codeshell.consumer.replace-network-guard')]=()=>{
globalThis.fetch=originalFetch;for(const {module,request,get} of saved){module.request=request;module.get=get;}
delete globalThis[Symbol.for('codeshell.consumer.replace-network-guard')];syncBuiltinESMExports();};
await import('./consumer.mjs');`,
  );
  const child = spawn(process.execPath, [bootstrap, resolve(process.argv[2]), root], {
    stdio: "inherit",
    env: process.env,
  });
  let forced = false;
  const deadline = setTimeout(() => {
    forced = true;
    child.kill("SIGTERM");
  }, 180_000);
  try {
    const terminal = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => done({ code, signal, forced }));
    });
    assert.deepEqual(terminal, { code: 0, signal: null, forced: false });
    console.log("consumer: natural Node exit 0");
  } finally {
    clearTimeout(deadline);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
