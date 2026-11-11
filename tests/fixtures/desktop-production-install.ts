// Install only external production dependencies into disposable directories.
// No application build, CodeShell installation, or mutation of workspace node_modules.
// bun scripts/run-isolated-node-smoke.mjs tests/fixtures/desktop-production-install.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  installProductionClosure,
  loadProductionClosures,
} from "../../packages/desktop/scripts/production-dependencies.js";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Use the isolated runner documented above");
const repoRoot = resolve(import.meta.dir, "../..");
const directory = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-production-install-")));
try {
  // Keep downloads and Bun's writable cache inside this diagnostic's directory.
  process.env.BUN_INSTALL_CACHE_DIR = join(directory, "cache");
  for (const [relativeDir, closure] of loadProductionClosures(repoRoot)) {
    const target = join(directory, relativeDir);
    mkdirSync(target, { recursive: true });
    installProductionClosure(join(repoRoot, relativeDir), target, closure);
    const manifest = JSON.parse(closure.manifest);
    const require = createRequire(join(target, "package.json"));
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      // MCP exposes subpaths rather than a bare package entry.
      const entry = name === "@modelcontextprotocol/sdk" ? `${name}/client/index.js` : name;
      assert.ok(
        require.resolve(entry).startsWith(target),
        `${name} must resolve inside its closure`,
      );
    }
    if (relativeDir === "packages/core") {
      for (const name of ["tldts", "tldts-core"])
        assert.equal(
          JSON.parse(readFileSync(join(target, "node_modules", name, "package.json"), "utf8"))
            .version,
          "7.4.19",
        );
      const sdkRequire = createRequire(
        require.resolve("@modelcontextprotocol/sdk/client/index.js"),
      );
      assert.ok(sdkRequire.resolve("cross-spawn").startsWith(target));
    }
    console.log(`PASS: frozen production installation and resolution for ${relativeDir}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
