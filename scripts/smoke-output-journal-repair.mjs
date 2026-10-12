import assert from "node:assert/strict";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This executable must run through run-isolated-node-smoke.mjs. Deny before Core imports.
assert(process.env.CODE_SHELL_TEST_HOME && process.env.HOME);
const deny = () => {
  throw new Error("Native repair fixture denied network");
};
globalThis.fetch = deny;
http.get =
  http.request =
  https.get =
  https.request =
  net.connect =
  net.createConnection =
  net.Socket.prototype.connect =
  tls.connect =
    deny;
syncBuiltinESMExports();
const { SessionManager } = await import("../packages/core/dist/session/session-manager.js");
const { SessionOutputJournal, readOutputJournal } =
  await import("../packages/core/dist/session/output-journal.js");
const { initializeOutputStorage } =
  await import("../packages/core/dist/session/output-journal-storage.js");
const { readPublishedOutputHead } =
  await import("../packages/core/dist/session/output-journal-head.js");
const { lockSync } = await import("../packages/core/dist/utils/lockfile.js");
const cli = fileURLToPath(
  new URL("../packages/core/dist/cli/output-journal-repair.js", import.meta.url),
);
const base = fs.mkdtempSync(join(tmpdir(), "codeshell-native-repair-"));
try {
  const guard = join(base, "deny-network.mjs");
  fs.writeFileSync(
    guard,
    `import http from "node:http"; import https from "node:https"; import net from "node:net"; import tls from "node:tls"; import {syncBuiltinESMExports} from "node:module"; const deny=()=>{throw new Error("Native CLI denied network")}; globalThis.fetch=deny; http.get=http.request=https.get=https.request=net.connect=net.createConnection=net.Socket.prototype.connect=tls.connect=deny; syncBuiltinESMExports();`,
  );
  const receipts = [];
  for (const segmented of [false, true]) {
    const root = join(base, segmented ? "segmented" : "single");
    fs.mkdirSync(root, { mode: 0o700 });
    const manager = new SessionManager(root),
      session = manager.create(root, "fixture", "fixture", "native-repair");
    manager.startSessionRun(session.state, "fixture-run");
    const id = session.state.sessionId,
      directory = join(root, id),
      anchor = join(directory, "output-journal.jsonl"),
      writer = new SessionOutputJournal(root, id, "fixture-run");
    writer.append({ type: "text_delta", text: "native repair " + "汉🙂".repeat(50000) });
    if (segmented) {
      const statePath = join(directory, "state.json"),
        release = lockSync(statePath, { realpath: false, retries: 0 }),
        fd = fs.openSync(anchor, "r+");
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8")),
          head = readPublishedOutputHead(directory, state.outputJournalHead),
          start = {
            sequence: 0,
            offset: fs.readFileSync(anchor).indexOf(10) + 1,
            hash: state.outputJournalIdentity,
          };
        initializeOutputStorage(
          fd,
          directory,
          head.identity,
          start,
          head,
          state.outputJournalHead,
          (pin) =>
            fs.writeFileSync(
              statePath,
              JSON.stringify({ ...state, outputJournalStorage: pin }) + "\n",
              { flush: true },
            ),
        );
      } finally {
        fs.closeSync(fd);
        release();
      }
      writer.append({ type: "text_delta", text: "missing retained segment" });
    }
    const through = readOutputJournal(root, id).through,
      inode = fs.statSync(anchor).ino,
      bundle = join(base, segmented ? "segmented-backup" : "single-backup");
    const run = (...args) => {
      const result = spawnSync(process.execPath, ["--import", guard, cli, ...args], {
        encoding: "utf8",
        env: process.env,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(run("backup", root, id, bundle).through, through);
    if (segmented) {
      const manifest = JSON.parse(
        fs.readFileSync(join(directory, "output-journal-segments.json"), "utf8"),
      ).manifest;
      fs.unlinkSync(join(directory, manifest.segments[0].name));
    } else {
      const bytes = fs.readFileSync(anchor);
      bytes[bytes.length - 10] ^= 1;
      fs.writeFileSync(anchor, bytes);
    }
    assert.equal(run("inspect", root, id).status, "incomplete");
    const repaired = run("restore", root, id, bundle);
    assert.equal(repaired.coverage, "ok");
    assert.equal(repaired.through, through);
    assert.equal(fs.statSync(anchor).ino, inode);
    assert.equal(run("inspect", root, id).status, "ok");
    let after,
      frames = 0;
    for (;;) {
      const page = readOutputJournal(root, id, { after, through, maxFrames: 2 });
      assert.equal(page.status, "ok");
      assert.equal(page.through, through);
      frames += page.frames.length;
      if (page.complete) break;
      assert(page.next && page.next !== after);
      after = page.next;
    }
    receipts.push({
      storage: segmented ? "segmented-missing" : "single-corrupt",
      frames,
      cursorPreserved: true,
      anchorInodePreserved: true,
      node: process.version,
    });
  }
  console.log(JSON.stringify({ nativeRepairCli: receipts }));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
