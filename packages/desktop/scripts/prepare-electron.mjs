// Electron 45 resolves and downloads its distribution on first require.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const expected = require("electron/package.json").version;
const actual = execFileSync(require("electron"), ["-p", "process.versions.electron"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  encoding: "utf8",
  timeout: 30_000,
}).trim();
assert.equal(actual, expected, "Electron executable must match the locked package");
console.log(`Prepared Electron ${actual} for ${process.platform}/${process.arch}`);
