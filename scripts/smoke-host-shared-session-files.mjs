import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";

// This script is launched only through run-isolated-node-smoke.mjs.
installLocalNetworkGuard("http://127.0.0.1:34723");
const narrow = await import("../packages/host/dist/index.session-files.js");
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
for (const name of ["probeMcp", "probeConfiguredModel", "readSkillInventory", "HostRuntime"])
  assert.equal(narrow[name], undefined);
assert.equal(narrow.readSessionFile, host.readSessionFile);
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
  // Lists alone retry ordinary atomic state replacement. Every failed attempt
  // closes its handles, and one pinned directory identity fences all attempts.
  for (const asynchronous of [false, true]) {
    for (const replacement of ["once", "continuous", "symlink", "directory"]) {
      const id = `retry-${asynchronous}-${replacement}`;
      const directory = join(root, id),
        file = join(directory, "state.json");
      fs.mkdirSync(directory);
      fs.writeFileSync(file, '{"marker":"original"}');
      let reads = 0;
      const mutate = () => {
        reads++;
        if (replacement === "once" && reads > 1) return;
        if (replacement === "directory") {
          fs.renameSync(directory, `${directory}-old`);
          fs.mkdirSync(directory);
          fs.writeFileSync(file, "{}");
        } else if (replacement === "symlink") {
          fs.renameSync(file, `${file}-old`);
          fs.symlinkSync(`${file}-old`, file);
        } else {
          const temp = `${file}.new`;
          fs.writeFileSync(temp, '{"marker":"new"}');
          fs.renameSync(temp, file);
        }
      };
      const originalRead = fs.readSync,
        originalOpen = fs.openSync,
        originalClose = fs.closeSync,
        originalAsyncOpen = fs.promises.open;
      const descriptors = new Set(),
        handles = [];
      if (asynchronous)
        fs.promises.open = async (...args) => {
          const handle = await originalAsyncOpen(...args);
          handles.push(handle);
          if (String(args[0]).endsWith("state.json")) {
            const read = handle.read.bind(handle);
            handle.read = async (...values) => {
              const result = await read(...values);
              mutate();
              return result;
            };
          }
          return handle;
        };
      else {
        fs.openSync = (...args) => {
          const fd = originalOpen(...args);
          descriptors.add(fd);
          return fd;
        };
        fs.closeSync = (fd) => {
          originalClose(fd);
          descriptors.delete(fd);
        };
        fs.readSync = (...args) => {
          const count = originalRead(...args);
          mutate();
          return count;
        };
        syncBuiltinESMExports();
      }
      try {
        const read = () =>
          asynchronous
            ? narrow.readSessionListState(root, id, 1024)
            : narrow.readSessionListStateSync(root, id, 1024);
        if (replacement === "once") assert.equal(await read(), '{"marker":"new"}');
        else if (asynchronous) await assert.rejects(read());
        else assert.throws(read);
        assert.equal(
          reads,
          replacement === "once" ? 2 : replacement === "continuous" ? 3 : 1,
          "bounded attempts",
        );
        assert.equal(descriptors.size, 0, "each sync descriptor closes on success/failure");
        for (const handle of handles)
          assert.equal(handle.fd, -1, "each async handle closes on success/failure");
      } finally {
        fs.readSync = originalRead;
        fs.openSync = originalOpen;
        fs.closeSync = originalClose;
        fs.promises.open = originalAsyncOpen;
        syncBuiltinESMExports();
      }
    }
  }
  const scanRoot = join(root, "scanner");
  const manager = new publicCore.SessionManager(scanRoot);
  manager.create(scanRoot, "fixture", "fixture", "scan-denied", null, "desktop");
  const originalStat = fs.lstatSync,
    originalOpen = fs.openSync;
  let stats = 0,
    opens = 0;
  fs.lstatSync = (...args) => {
    stats++;
    if (String(args[0]).endsWith("transcript.jsonl"))
      throw Object.assign(new Error("fixture unreadable transcript"), { code: "EACCES" });
    return originalStat(...args);
  };
  fs.openSync = (...args) => {
    opens++;
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try {
    const storage = narrow.sessionListStorage(scanRoot);
    const candidates = storage.candidates();
    assert.equal(opens, 0, "candidate scan never opens each state/transcript");
    assert.equal(stats, 3, "one directory/state/transcript lstat per ordinary candidate");
    assert.equal(candidates[0].dir, "scan-denied");
    assert.equal(candidates[0].transcriptExists, false);
    const internal = await import("../packages/core/dist/index.internal.js");
    assert.equal(
      internal.listSessionEntries(scanRoot, 10, {}, storage)[0].sessionId,
      "scan-denied",
    );
  } finally {
    fs.lstatSync = originalStat;
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  }

  // Exercise actual production adapters, not only the retry primitive.
  const storage = await import("../packages/server/dist/index.storage.js");
  const hub = await import("../packages/server/dist/hub/session-management.js");
  const adapterRoot = join(root, "adapters");
  const adapterManager = new publicCore.SessionManager(adapterRoot);
  adapterManager.create(root, "fixture", "fixture", "atomic", null, "desktop");
  const stateFile = join(adapterRoot, "atomic", "state.json");
  let swapped = false;
  const replaceState = () => {
    if (swapped) return;
    swapped = true;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.title = "after atomic rename";
    fs.writeFileSync(`${stateFile}.new`, JSON.stringify(state));
    fs.renameSync(`${stateFile}.new`, stateFile);
  };
  const originalAsyncOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await originalAsyncOpen(...args);
    if (String(args[0]).endsWith("state.json")) {
      const read = handle.read.bind(handle);
      handle.read = async (...values) => {
        const result = await read(...values);
        replaceState();
        return result;
      };
    }
    return handle;
  };
  try {
    const page = await storage.listDiskSessions({ limit: 1 }, adapterRoot);
    assert.equal(page.sessions[0].title, "after atomic rename");
  } finally {
    fs.promises.open = originalAsyncOpen;
  }
  swapped = false;
  const originalRead = fs.readSync;
  fs.readSync = (...args) => {
    const result = originalRead(...args);
    replaceState();
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => hub.readHubSessionState(adapterRoot, "atomic"),
      (error) => error.status === 409,
      "single-session authorization read stays strict",
    );
  } finally {
    fs.readSync = originalRead;
    syncBuiltinESMExports();
  }

  const largeDir = join(adapterRoot, "large");
  fs.mkdirSync(largeDir);
  fs.writeFileSync(
    join(largeDir, "state.json"),
    JSON.stringify({ secret: "must-not-log-private-token", padding: "x".repeat(2 * 1024 * 1024) }),
  );
  const originalWarning = process.emitWarning,
    warnings = [];
  process.emitWarning = (...args) => {
    warnings.push(args);
  };
  try {
    await storage.listDiskSessions({ limit: 10 }, adapterRoot);
  } finally {
    process.emitWarning = originalWarning;
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].code, "SESSION_LIST_STATE_TOO_LARGE");
  assert.match(warnings[0][0], /2 MiB/);
  assert.doesNotMatch(JSON.stringify(warnings), /must-not-log-private-token|padding/);
  console.log(
    "Bounded list retries, closed handles, candidate syscall budget, strict Hub reads and safe size diagnostics passed",
  );
  console.log("Host service exports and four session identity replacement cases passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
