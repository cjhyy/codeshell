import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";

// This script is launched only through run-isolated-node-smoke.mjs.
installLocalNetworkGuard("http://127.0.0.1:34723");
const host = await import("../packages/host/dist/index.js");
for (const entry of [
  "readSkillInventory",
  "probeMcp",
  "probeConfiguredModel",
  "readSessionFile",
  "readSessionFileSync",
  "scanSessionDirectories",
  "scanSessionDirectoriesSync",
])
  assert.equal(typeof host[entry], "function", entry);
const publicCore = await import("../packages/core/dist/index.js");
assert.equal(publicCore.createMcpProbeConnection, undefined);
assert.equal(publicCore.listSessionEntries, undefined);
const root = fs.mkdtempSync(join(tmpdir(), "shared-session-smoke-"));
try {
  for (const asynchronous of [false, true]) {
    for (const replace of ["directory", "file"]) {
      const id = `${asynchronous ? "async" : "sync"}-${replace}`;
      const directory = join(root, id),
        file = join(directory, "state.json");
      fs.mkdirSync(directory);
      fs.writeFileSync(file, '{"marker":"original"}');
      let swapped = false;
      const swap = () => {
        if (swapped) return;
        swapped = true;
        if (replace === "directory") {
          fs.renameSync(directory, `${directory}-old`);
          fs.mkdirSync(directory);
        } else fs.renameSync(file, `${file}-old`);
        fs.writeFileSync(file, '{"marker":"replacement"}');
      };
      const originalRead = fs.readSync,
        originalOpen = fs.promises.open;
      const handles = [];
      if (asynchronous) {
        fs.promises.open = async (...args) => {
          const handle = await originalOpen(...args);
          handles.push(handle);
          if (String(args[0]).endsWith("state.json")) {
            const read = handle.read.bind(handle);
            handle.read = async (...values) => {
              const value = await read(...values);
              swap();
              return value;
            };
          }
          return handle;
        };
      } else {
        fs.readSync = (...args) => {
          const value = originalRead(...args);
          swap();
          return value;
        };
        syncBuiltinESMExports();
      }
      try {
        if (asynchronous)
          await assert.rejects(
            host.readSessionFile(root, id, "state.json", 1024),
            /changed during read/,
          );
        else
          assert.throws(
            () => host.readSessionFileSync(root, id, "state.json", 1024),
            /changed during read/,
          );
        assert.equal(swapped, true);
        for (const handle of handles)
          assert.equal(handle.fd, -1, "all opened handles close on identity failure");
      } finally {
        fs.readSync = originalRead;
        fs.promises.open = originalOpen;
        syncBuiltinESMExports();
      }
    }
  }
  console.log("Host service exports and four session identity replacement cases passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
