import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const networkAttempts = [];
const originals = [];
for (const [object, key] of [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net, "connect"],
  [net, "createConnection"],
]) {
  originals.push([object, key, object[key]]);
  object[key] = () => {
    networkAttempts.push(key);
    throw Error("Unexpected network");
  };
}
syncBuiltinESMExports();
const { collectWerDumpEvidence, runWerDumpEvidenceCli, WER_DUMP_LIMITS } =
  await import("./windows-wer-dump-evidence.mjs");
after(() => {
  for (const [object, key, value] of originals) object[key] = value;
  syncBuiltinESMExports();
  assert.deepEqual(networkAttempts, []);
});

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const withFixture = (run) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "wer-synthetic-")));
  const source = join(root, "source"),
    output = join(root, "output");
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  const put = (name, bytes = Buffer.from("synthetic memory only")) => {
    fs.writeFileSync(join(source, name), bytes);
    return bytes;
  };
  const collect = (io) =>
    collectWerDumpEvidence({ source, output }, io ? { io: { ...fs, ...io } } : undefined);
  try {
    return run({ root, source, output, put, collect });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};
const readManifest = (output) =>
  JSON.parse(fs.readFileSync(join(output, "wer-dumps.json"), "utf8"));
const noManifest = (output) => assert.equal(fs.existsSync(join(output, "wer-dumps.json")), false);

test("empty explicit directories produce local bounded manifest and no source change", () =>
  withFixture(({ source, output, collect }) => {
    const report = collect();
    assert.deepEqual(report.dumps, []);
    assert.equal(report.truncated, false);
    assert.deepEqual(fs.readdirSync(source), []);
    assert.deepEqual(readManifest(output), report);
    assert.doesNotMatch(
      JSON.stringify(report),
      new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }));

test("exact names are case insensitive; copied bytes/hash and source hash are unchanged", () =>
  withFixture(({ source, output, put, collect }) => {
    const names = [
      "code-shell.exe.12.dmp",
      "ELECTRON.EXE.9.DMP",
      "code-shell-Setup-0.9.46-x64.exe.123.dmp",
    ];
    for (const name of names) put(name, Buffer.from(`synthetic ${name}`));
    for (const name of [
      "other.exe.1.dmp",
      "code-shell.exe.x.dmp",
      "code-shell.exe.1.dmp.bak",
      "code-shell-Setup-.exe.1.dmp",
      "code-shell.exe.1.dmp\n",
    ])
      put(name);
    const before = names.map((name) => sha(fs.readFileSync(join(source, name))));
    const report = collect();
    assert.deepEqual(
      report.dumps.map((row) => row.name),
      [...names].sort(),
    );
    assert.equal(report.truncated, false);
    for (const row of report.dumps) {
      assert.deepEqual(Object.keys(row).sort(), ["mtime", "name", "sha256", "size"]);
      assert.equal(row.sha256, sha(fs.readFileSync(join(output, row.name))));
      assert.equal(row.sha256, before[names.indexOf(row.name)]);
      assert.equal(sha(fs.readFileSync(join(source, row.name))), row.sha256);
      assert.equal(row.size, fs.statSync(join(output, row.name)).size);
      assert.equal(
        row.mtime,
        fs.statSync(join(source, row.name), { bigint: true }).mtime.toISOString(),
      );
      if (process.platform !== "win32")
        assert.equal(fs.statSync(join(output, row.name)).mode & 0o777, 0o600);
    }
    if (process.platform !== "win32")
      assert.equal(fs.statSync(join(output, "wer-dumps.json")).mode & 0o777, 0o600);
  }));

test("four-file limit sorts candidates, records excess accurately and ignores directory garbage", () =>
  withFixture(({ output, put, collect }) => {
    for (const number of [9, 8, 7, 6, 5, 4]) put(`electron.exe.${number}.dmp`);
    put("garbage.txt");
    const report = collect();
    assert.equal(report.dumps.length, 4);
    assert.deepEqual(
      report.dumps.map((row) => row.name),
      [4, 5, 6, 7].map((n) => `electron.exe.${n}.dmp`),
    );
    assert.deepEqual(
      report.skipped.map((row) => row.reason),
      ["file-count-limit", "file-count-limit"],
    );
    assert.equal(report.truncated, true);
    assert.equal(fs.readdirSync(output).length, 5);
  }));

test("64MiB inclusive boundary and overlarge sparse input are bounded in fixed chunks", () =>
  withFixture(({ source, output, put, collect }) => {
    put("code-shell.exe.1.dmp", Buffer.alloc(0));
    put("electron.exe.2.dmp", Buffer.alloc(0));
    fs.truncateSync(join(source, "code-shell.exe.1.dmp"), 64 * 1024 * 1024);
    fs.truncateSync(join(source, "electron.exe.2.dmp"), 64 * 1024 * 1024 + 1);
    let largestRead = 0,
      bytes = 0;
    const report = collect({
      readSync(fd, buffer, offset, length, position) {
        largestRead = Math.max(largestRead, length);
        const count = fs.readSync(fd, buffer, offset, length, position);
        bytes += count;
        return count;
      },
    });
    assert.equal(report.dumps[0].size, 64 * 1024 * 1024);
    assert.equal(report.dumps[0].sha256, sha(Buffer.alloc(64 * 1024 * 1024)));
    assert.equal(report.skipped[0].reason, "file-size-limit");
    assert.equal(report.truncated, true);
    assert.equal(bytes, 2 * 64 * 1024 * 1024 + fs.statSync(join(output, "wer-dumps.json")).size);
    assert.ok(bytes <= WER_DUMP_LIMITS.readBytes);
    assert.ok(largestRead <= WER_DUMP_LIMITS.chunkBytes);
    assert.equal(fs.existsSync(join(output, "electron.exe.2.dmp")), false);
  }));

test("total output budget includes manifest reserve and never reads the fourth maximal dump", () =>
  withFixture(({ source, output, put, collect }) => {
    for (let n = 1; n <= 4; n++) {
      put(`electron.exe.${n}.dmp`, Buffer.alloc(0));
      fs.truncateSync(join(source, `electron.exe.${n}.dmp`), 64 * 1024 * 1024);
    }
    let bytes = 0;
    const report = collect({
      readSync(...args) {
        const count = fs.readSync(...args);
        bytes += count;
        return count;
      },
    });
    assert.equal(report.dumps.length, 3);
    assert.equal(report.skipped[0].reason, "total-output-limit");
    assert.equal(
      bytes,
      2 * 3 * 64 * 1024 * 1024 + fs.statSync(join(output, "wer-dumps.json")).size,
    );
    assert.ok(bytes <= WER_DUMP_LIMITS.readBytes);
    assert.ok(
      fs.readdirSync(output).reduce((sum, name) => sum + fs.statSync(join(output, name)).size, 0) <=
        256 * 1024 * 1024,
    );
  }));

test("enumeration and name budgets bound noncandidate garbage without calling it dumps", () =>
  withFixture(({ source, collect }) => {
    for (let n = 0; n < WER_DUMP_LIMITS.entries + 10; n++)
      fs.writeFileSync(join(source, `garbage-${n}`), "");
    let reads = 0;
    const report = collect({
      opendirSync(...args) {
        assert.equal(args[1]?.bufferSize, 1);
        const dir = fs.opendirSync(...args);
        return {
          readSync() {
            reads++;
            return dir.readSync();
          },
          closeSync: () => dir.closeSync(),
        };
      },
    });
    assert.equal(reads, WER_DUMP_LIMITS.entries + 1);
    assert.deepEqual(report.dumps, []);
    assert.equal(report.truncated, true);
    assert.ok(report.reasons.includes("entry-limit"));
  }));

for (const kind of ["directory", "symlink", "fifo"])
  test(`candidate ${kind} is refused without content read`, () =>
    withFixture(({ source, output, collect }) => {
      const file = join(source, "electron.exe.1.dmp");
      if (kind === "directory") fs.mkdirSync(file);
      if (kind === "symlink") fs.symlinkSync("missing-target", file);
      if (kind === "fifo") {
        if (process.platform === "win32") return;
        execFileSync("mkfifo", [file]);
      }
      assert.throws(() => collect(), /WER evidence refused/);
      noManifest(output);
    }));

for (const existing of ["electron.exe.1.dmp", "wer-dumps.json"])
  test(`existing target ${existing} is preserved`, () =>
    withFixture(({ output, put, collect }) => {
      put("electron.exe.1.dmp");
      fs.writeFileSync(join(output, existing), "unknown private file");
      assert.throws(() => collect(), /WER evidence refused/);
      assert.equal(fs.readFileSync(join(output, existing), "utf8"), "unknown private file");
    }));

for (const mutation of ["truncate", "grow", "replace"])
  test(`mid-copy ${mutation} fails and leaves no success manifest`, () =>
    withFixture(({ source, output, put, collect }) => {
      const name = "electron.exe.1.dmp";
      put(name, Buffer.alloc(128 * 1024, 42));
      let changed = false;
      assert.throws(
        () =>
          collect({
            readSync(...args) {
              const count = fs.readSync(...args);
              if (!changed) {
                changed = true;
                const path = join(source, name);
                if (mutation === "truncate") fs.truncateSync(path, 1);
                if (mutation === "grow") fs.appendFileSync(path, "growth");
                if (mutation === "replace") {
                  fs.renameSync(path, path + ".old");
                  fs.writeFileSync(path, Buffer.alloc(128 * 1024, 17));
                }
              }
              return count;
            },
          }),
        /WER evidence refused/,
      );
      noManifest(output);
      assert.deepEqual(fs.readdirSync(output), []);
    }));

test("source/output alias, symlink roots and symlink ancestors are refused", () =>
  withFixture(({ root, source, output }) => {
    assert.throws(() => collectWerDumpEvidence({ source, output: source }), /WER evidence refused/);
    fs.symlinkSync(source, join(root, "alias"), "dir");
    for (const args of [
      { source: join(root, "alias"), output },
      { source, output: join(root, "alias") },
      { source: join(root, "alias", "child"), output },
    ])
      assert.throws(() => collectWerDumpEvidence(args), /WER evidence refused/);
    noManifest(output);
  }));

for (const side of ["source", "output", "parent"])
  test(`${side} identity swap before output open is refused before copying bytes`, () =>
    withFixture(({ root, source, output, put, collect }) => {
      put("electron.exe.1.dmp");
      let changed = false;
      assert.throws(
        () =>
          collect({
            openSync(path, ...args) {
              if (!changed && path === join(output, "electron.exe.1.dmp")) {
                changed = true;
                const victim = side === "parent" ? root : side === "source" ? source : output;
                fs.renameSync(victim, victim + ".old");
                fs.mkdirSync(victim);
                if (side === "parent") {
                  fs.mkdirSync(source);
                  fs.mkdirSync(output);
                }
              }
              return fs.openSync(path, ...args);
            },
          }),
        /WER evidence refused/,
      );
      noManifest(output);
      for (const path of [
        output,
        side === "parent" ? join(root + ".old", "output") : output + ".old",
      ])
        if (fs.existsSync(path))
          for (const name of fs.readdirSync(path))
            assert.equal(fs.statSync(join(path, name)).size, 0);
      if (side === "parent") fs.rmSync(root + ".old", { recursive: true, force: true });
    }));

test("CLI requires explicit source/output, help explains sensitive local memory, errors redact paths", () => {
  for (const args of [
    [],
    ["--source", "PRIVATE"],
    ["--output", "PRIVATE"],
    ["--source", "a", "--output", "b", "--upload"],
    ["--source", "a", "--source", "b", "--output", "c"],
  ]) {
    const text = [];
    let calls = 0;
    assert.equal(
      runWerDumpEvidenceCli(args, {
        collect: () => {
          calls++;
        },
        print: (line) => text.push(line),
      }),
      1,
    );
    assert.equal(calls, 0);
    assert.doesNotMatch(text.join(""), /PRIVATE/);
  }
  const text = [];
  assert.equal(runWerDumpEvidenceCli(["--help"], { print: (line) => text.push(line) }), 0);
  assert.match(text.join(""), /sensitive memory/i);
  assert.match(text.join(""), /local/i);
  assert.match(text.join(""), /ACL/);
  assert.equal(
    runWerDumpEvidenceCli(["--source", "a", "--output", "b"], {
      collect: () => {
        throw Error("PRIVATE full path");
      },
      print: (line) => text.push(line),
    }),
    1,
  );
  assert.doesNotMatch(text.join(""), /PRIVATE/);
});

test("listed-name byte budget bounds long garbage names independently of entry count", () =>
  withFixture(({ source, collect }) => {
    for (let n = 0; n < WER_DUMP_LIMITS.entries; n++)
      fs.writeFileSync(join(source, `${String(n).padStart(3, "0")}-${"x".repeat(240)}`), "");
    let reads = 0;
    const report = collect({
      opendirSync(...args) {
        const dir = fs.opendirSync(...args);
        return {
          readSync() {
            reads++;
            return dir.readSync();
          },
          closeSync: () => dir.closeSync(),
        };
      },
    });
    assert.ok(reads < WER_DUMP_LIMITS.entries);
    assert.deepEqual(report.dumps, []);
    assert.deepEqual(report.reasons, ["listed-name-limit"]);
  }));

test("overlong synthetic directory names are bounded and never treated as dumps", () =>
  withFixture(({ collect }) => {
    let reads = 0,
      closed = false;
    const report = collect({
      opendirSync() {
        return {
          readSync() {
            return reads++ ? null : { name: "x".repeat(WER_DUMP_LIMITS.nameBytes + 1) };
          },
          closeSync() {
            closed = true;
          },
        };
      },
    });
    assert.equal(closed, true);
    assert.deepEqual(report.dumps, []);
    assert.deepEqual(report.reasons, ["name-limit"]);
  }));

test("path and ancestor budgets refuse before file opens", () =>
  withFixture(({ root, source, output }) => {
    let opens = 0;
    const io = {
      ...fs,
      openSync() {
        opens++;
        throw Error("unexpected open");
      },
    };
    assert.throws(
      () =>
        collectWerDumpEvidence(
          { source: "/" + "x".repeat(WER_DUMP_LIMITS.pathChars), output },
          { io },
        ),
      /WER evidence refused/,
    );
    let deep = root;
    for (let n = 0; n < WER_DUMP_LIMITS.ancestors; n++) {
      deep = join(deep, "d");
      fs.mkdirSync(deep);
    }
    assert.throws(
      () => collectWerDumpEvidence({ source: deep, output }, { io }),
      /WER evidence refused/,
    );
    assert.equal(opens, 0);
    assert.throws(
      () => collectWerDumpEvidence({ source, output: join(source, "nested") }),
      /WER evidence refused/,
    );
  }));

test("read-only source flags, short writes and final manifest budget are exercised", () =>
  withFixture(({ source, output, put, collect }) => {
    const name = "code-shell.exe.7.dmp",
      bytes = put(name, Buffer.alloc(130_001, 42));
    let sourceOpened = false,
      writeCalls = 0;
    const report = collect({
      openSync(path, flags, ...args) {
        if (path === join(source, name)) {
          sourceOpened = true;
          assert.equal(
            flags &
              (fs.constants.O_WRONLY |
                fs.constants.O_RDWR |
                fs.constants.O_TRUNC |
                fs.constants.O_CREAT),
            0,
          );
          assert.equal(flags & (fs.constants.O_NONBLOCK ?? 0), fs.constants.O_NONBLOCK ?? 0);
        }
        return fs.openSync(path, flags, ...args);
      },
      writeSync(fd, buffer, offset, length) {
        writeCalls++;
        return fs.writeSync(fd, buffer, offset, Math.min(length, 1000));
      },
    });
    assert.equal(sourceOpened, true);
    assert.ok(writeCalls > 100);
    assert.equal(report.dumps[0].sha256, sha(bytes));
    assert.ok(fs.statSync(join(output, "wer-dumps.json")).size <= WER_DUMP_LIMITS.manifestBytes);
  }));

for (const fault of [
  "source-open-replacement",
  "source-open-fifo",
  "output-symlink",
  "manifest-write",
  "manifest-parent-swap",
])
  test(`injected ${fault} refuses with no readable successful manifest`, () =>
    withFixture(({ root, source, output, put, collect }) => {
      if (fault === "source-open-fifo" && process.platform === "win32") return;
      const name = "electron.exe.1.dmp";
      put(name, Buffer.alloc(128_000, 42));
      let manifest,
        changed = false;
      const external = join(root, "external");
      fs.mkdirSync(external);
      const io = {
        openSync(path, flags, ...args) {
          if (!changed && path === join(source, name) && fault.startsWith("source-open")) {
            changed = true;
            fs.renameSync(path, path + ".old");
            if (fault === "source-open-fifo") execFileSync("mkfifo", [path]);
            else fs.writeFileSync(path, Buffer.alloc(128_000, 17));
          }
          if (!changed && path === join(output, name) && fault === "output-symlink") {
            changed = true;
            fs.renameSync(output, output + ".old");
            fs.symlinkSync(external, output, "dir");
          }
          const fd = fs.openSync(path, flags, ...args);
          if (path === join(output, "wer-dumps.json")) manifest = fd;
          return fd;
        },
        writeSync(fd, ...args) {
          if (fd === manifest && fault === "manifest-write") {
            fs.writeSync(fd, Buffer.from("{ partial"));
            throw Error("synthetic write failure");
          }
          const count = fs.writeSync(fd, ...args);
          if (fd === manifest && fault === "manifest-parent-swap" && !changed) {
            changed = true;
            fs.renameSync(output, output + ".old");
            fs.mkdirSync(output);
          }
          return count;
        },
      };
      assert.throws(() => collect(io), /WER evidence refused/);
      noManifest(output);
      for (const directory of [external, output + ".old"])
        if (fs.existsSync(directory))
          for (const name of fs.readdirSync(directory)) {
            if (name === "wer-dumps.json")
              assert.throws(() => JSON.parse(fs.readFileSync(join(directory, name), "utf8")));
            if (fault === "output-symlink")
              assert.equal(fs.statSync(join(directory, name)).size, 0);
          }
    }));

test("CLI success calls only the explicit collector and reports bounded counts", () => {
  const text = [],
    calls = [];
  assert.equal(
    runWerDumpEvidenceCli(["--source", "explicit-source", "--output", "explicit-output"], {
      collect(args) {
        calls.push(args);
        return { dumps: [], truncated: false };
      },
      print: (line) => text.push(line),
    }),
    0,
  );
  assert.deepEqual(calls, [{ source: "explicit-source", output: "explicit-output" }]);
  assert.doesNotMatch(text.join(""), /explicit-source|explicit-output/);
});

for (const mutation of ["replace", "rewrite", "hardlink"])
  test(`completed destination ${mutation} during next copy invalidates the manifest`, () =>
    withFixture(({ source, output, put, collect }) => {
      put("electron.exe.1.dmp", Buffer.alloc(128_000, 42));
      put("electron.exe.2.dmp", Buffer.alloc(128_000, 42));
      const descriptors = new Map();
      let changed = false;
      assert.throws(
        () =>
          collect({
            openSync(path, ...args) {
              const fd = fs.openSync(path, ...args);
              descriptors.set(fd, path);
              return fd;
            },
            readSync(fd, ...args) {
              const count = fs.readSync(fd, ...args);
              if (!changed && descriptors.get(fd) === join(source, "electron.exe.2.dmp")) {
                changed = true;
                const first = join(output, "electron.exe.1.dmp");
                if (mutation === "replace") {
                  fs.renameSync(first, first + ".unknown");
                  fs.writeFileSync(first, Buffer.alloc(128_000, 17));
                }
                if (mutation === "rewrite") fs.writeFileSync(first, Buffer.alloc(128_000, 17));
                if (mutation === "hardlink") fs.linkSync(first, first + ".link");
              }
              return count;
            },
          }),
        /WER evidence refused/,
      );
      noManifest(output);
      if (mutation === "replace")
        assert.equal(fs.readFileSync(join(output, "electron.exe.1.dmp"))[0], 17);
    }));

test("distinct path spellings resolving to the same directory identity are refused", () =>
  withFixture(({ source, output }) => {
    let opens = 0;
    assert.throws(
      () =>
        collectWerDumpEvidence(
          { source, output },
          {
            io: {
              ...fs,
              lstatSync(path, options) {
                return fs.lstatSync(path === output ? source : path, options);
              },
              openSync() {
                opens++;
                throw Error("unexpected open");
              },
            },
          },
        ),
      /WER evidence refused/,
    );
    assert.equal(opens, 0);
  }));

test("exclusive private output creation bounds descriptors and closes them on success", () =>
  withFixture(({ source, put, collect }) => {
    for (let n = 1; n <= 4; n++) put(`electron.exe.${n}.dmp`, Buffer.from(`synthetic ${n}`));
    const open = new Set();
    let peak = 0,
      outputs = 0;
    const report = collect({
      openSync(path, flags, mode) {
        if (!path.startsWith(source + "/") && !path.startsWith(source + "\\")) {
          outputs++;
          assert.equal(mode, 0o600);
          assert.equal(flags & fs.constants.O_EXCL, fs.constants.O_EXCL);
          assert.equal(flags & fs.constants.O_CREAT, fs.constants.O_CREAT);
        }
        const fd = fs.openSync(path, flags, mode);
        open.add(fd);
        peak = Math.max(peak, open.size);
        return fd;
      },
      closeSync(fd) {
        fs.closeSync(fd);
        assert.equal(open.delete(fd), true);
      },
    });
    assert.equal(report.dumps.length, 4);
    assert.equal(outputs, 5);
    assert.ok(peak <= 5);
    assert.equal(open.size, 0);
  }));

test("four sparse dumps exactly fill the payload budget while leaving bounded manifest room", () =>
  withFixture(({ source, output, put, collect }) => {
    for (let n = 1; n <= 4; n++) {
      const name = `electron.exe.${n}.dmp`;
      put(name, Buffer.alloc(0));
      fs.truncateSync(
        join(source, name),
        WER_DUMP_LIMITS.fileBytes - (n === 4 ? WER_DUMP_LIMITS.manifestBytes : 0),
      );
    }
    let readBytes = 0;
    const report = collect({
      readSync(...args) {
        const count = fs.readSync(...args);
        readBytes += count;
        return count;
      },
    });
    assert.equal(report.dumps.length, 4);
    assert.equal(report.truncated, false);
    assert.equal(
      report.dumps.reduce((sum, row) => sum + row.size, 0),
      WER_DUMP_LIMITS.outputBytes - WER_DUMP_LIMITS.manifestBytes,
    );
    assert.equal(
      readBytes,
      2 * (WER_DUMP_LIMITS.outputBytes - WER_DUMP_LIMITS.manifestBytes) +
        fs.statSync(join(output, "wer-dumps.json")).size,
    );
    assert.ok(readBytes <= WER_DUMP_LIMITS.readBytes);
    assert.ok(
      fs.readdirSync(output).reduce((sum, name) => sum + fs.statSync(join(output, name)).size, 0) <=
        WER_DUMP_LIMITS.outputBytes,
    );
  }));

for (const kind of ["dump", "manifest"])
  test(`${kind} modified in place during its own write cannot acquire a successful manifest`, () =>
    withFixture(({ output, put, collect }) => {
      put("electron.exe.1.dmp", Buffer.alloc(128_000, 42));
      const descriptors = new Map();
      let changed = false;
      assert.throws(
        () =>
          collect({
            openSync(path, ...args) {
              const fd = fs.openSync(path, ...args);
              descriptors.set(fd, path);
              return fd;
            },
            writeSync(fd, ...args) {
              const count = fs.writeSync(fd, ...args),
                path = descriptors.get(fd);
              if (
                !changed &&
                path === join(output, kind === "dump" ? "electron.exe.1.dmp" : "wer-dumps.json")
              ) {
                changed = true;
                const other = fs.openSync(path, "r+");
                try {
                  const bytes = fs.readFileSync(path);
                  const position =
                    kind === "dump"
                      ? 0
                      : bytes.indexOf('"schemaVersion": ') + Buffer.byteLength('"schemaVersion": ');
                  fs.writeSync(
                    other,
                    Buffer.from(kind === "dump" ? "corrupt bytes" : "2"),
                    0,
                    kind === "dump" ? 13 : 1,
                    position,
                  );
                  if (kind === "manifest")
                    assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).schemaVersion, 2);
                } finally {
                  fs.closeSync(other);
                }
              }
              return count;
            },
          }),
        /WER evidence refused/,
      );
      assert.equal(changed, true);
      noManifest(output);
    }));

test("source changed during destination verification is refused before closing its source fd", () =>
  withFixture(({ source, output, put, collect }) => {
    const name = "electron.exe.1.dmp";
    put(name, Buffer.alloc(128_000, 42));
    const descriptors = new Map();
    let changed = false;
    assert.throws(
      () =>
        collect({
          openSync(path, ...args) {
            const fd = fs.openSync(path, ...args);
            descriptors.set(fd, path);
            return fd;
          },
          readSync(fd, ...args) {
            const count = fs.readSync(fd, ...args);
            if (!changed && descriptors.get(fd) === join(output, name)) {
              changed = true;
              fs.truncateSync(join(source, name), 1);
            }
            return count;
          },
        }),
      /WER evidence refused/,
    );
    assert.equal(changed, true);
    noManifest(output);
  }));
