import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute the actual wrapper body in a VM with every imported effect inert.
// The test never imports the environment creator or calls a real child/fs writer.
const url = new URL("./run-isolated-node-smoke.mjs", import.meta.url);
const source = readFileSync(url, "utf8");
function compileWrapper(rawSource) {
  const source = rawSource.replace(/\r\n/g, "\n");
  const imports = source.match(/^import[^;]+;$/gm) ?? [];
  assert.deepEqual(
    imports,
    [
      'import { spawn } from "node:child_process";',
      'import { lstatSync, mkdtempSync, rmSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'import { createBunTestEnvironment } from "./bun-test-completion.mjs";',
    ],
    "Review any changed wrapper imports before executing this VM",
  );
  const body = source
    .replace(/^import[^;]+;\n/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(url.href));
  return new Script(`(async () => {\n${body}\n})()`, { filename: url.pathname });
}
const script = compileWrapper(source);

async function invoke(
  args,
  {
    entries = ["one.test.mjs", "two.test.mjs"],
    platform = "darwin",
    electron = false,
    close = { code: 0, signal: null },
    spawnError = null,
  } = {},
  selectedScript = script,
) {
  const calls = [];
  const errors = [];
  const process = {
    argv: ["node", "wrapper", ...args],
    execPath: "/owned/node",
    env: { FIXTURE: "only" },
    versions: electron ? { electron: "owned" } : {},
    platform,
    exitCode: undefined,
  };
  const files = new Map(
    entries.map((entry) => (typeof entry === "string" ? [entry, "file"] : entry)),
  );
  const fakeFs = {
    lstatSync(path) {
      calls.push(["lstat", path]);
      const kind = files.get(path);
      if (!kind) throw Object.assign(Error("missing"), { code: "ENOENT" });
      return { isFile: () => kind === "file", isSymbolicLink: () => kind === "link" };
    },
    mkdtempSync(prefix) {
      calls.push(["home", prefix]);
      return "/owned/private";
    },
    rmSync(...args) {
      calls.push(["remove", ...args]);
    },
  };
  await selectedScript.runInNewContext({
    ...fakeFs,
    join,
    fileURLToPath,
    URL,
    process,
    console: { error: (message) => errors.push(message) },
    tmpdir: () => "/owned/tmp",
    createBunTestEnvironment(env, home) {
      calls.push(["environment", env, home]);
      return { OWNED: home };
    },
    spawn(executable, vector, options) {
      calls.push(["spawn", executable, vector, options]);
      const child = new EventEmitter();
      queueMicrotask(() =>
        spawnError
          ? child.emit("error", spawnError)
          : child.emit("close", close.code, close.signal),
      );
      return child;
    },
  });
  return { calls, errors, exitCode: process.exitCode };
}
function refused(value) {
  assert.equal(value.exitCode, 1);
  assert.equal(value.errors.length, 1);
  assert.equal(
    value.calls.some(([kind]) => ["home", "environment", "spawn", "remove"].includes(kind)),
    false,
    "refusal must precede all HOME/spawn/cleanup effects",
  );
}

test("actual LF and CRLF wrapper bytes execute the same guarded VM paths", async () => {
  const lf = source.replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.notEqual(lf, crlf);
  const snapshots = [];
  for (const text of [lf, crlf]) {
    const selected = compileWrapper(text);
    const value = await invoke(["--test", "one.test.mjs"], {}, selected);
    assert.equal(value.exitCode, undefined);
    assert.deepEqual(value.errors, []);
    assert.deepEqual(Array.from(value.calls.find(([kind]) => kind === "spawn")[2]), [
      "--test",
      "one.test.mjs",
    ]);
    snapshots.push(JSON.parse(JSON.stringify(value.calls)));
    const bare = await invoke(["--test"], {}, selected);
    refused(bare);
    assert.equal(bare.calls.length, 0);
    refused(await invoke(["--test", "--watch", "one.test.mjs"], {}, selected));
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test("bare/options-only test mode refuses before HOME and spawn", async () => {
  for (const args of [
    [],
    ["--test"],
    ["--private-keyring", "--test"],
    ["--test", "--test-name-pattern", "owned"],
    ["--test", "--test-skip-pattern=actual native owned child"],
  ]) {
    const result = await invoke(args);
    refused(result);
    assert.equal(result.calls.length, 0);
  }
});

test("directory, missing, symlink, special and glob selectors cannot discover tests", async () => {
  for (const [path, kind] of [
    ["packages", "directory"],
    [".", "directory"],
    ["missing.test.mjs", null],
    ["linked.test.mjs", "link"],
    ["socket.test.mjs", "socket"],
    ["*.test.mjs", "file"],
    ["packages/**/one.test.mjs", "file"],
    ["[ab].test.mjs", "file"],
    ["{one,two}.test.mjs", "file"],
  ]) {
    refused(await invoke(["--test", path], { entries: kind ? [[path, kind]] : [] }));
  }
});

test("invalid flags and selectors never become file discovery or swallowed Node options", async () => {
  for (const args of [
    ["--test", "--import=owned.mjs", "one.test.mjs"],
    ["--test", "--watch", "one.test.mjs"],
    ["--test", "--test-name-pattern"],
    ["--test", "--test-name-pattern="],
    ["--test", "--test-name-pattern", "--test", "one.test.mjs"],
    ["--test", "--test-name-pattern=x", "--test-name-pattern=y", "one.test.mjs"],
    ["--test", "one.test.mjs", "--test-skip-pattern=x"],
    ["--test", "--", "one.test.mjs"],
    ["--test=one.test.mjs"],
    ["--unknown"],
    ["--test", "bad\0file"],
    ["--test", "--test-skip-pattern=bad\npattern", "one.test.mjs"],
    ["--test", "x".repeat(4097)],
    ["--test", "--test-name-pattern=" + "x".repeat(2049), "one.test.mjs"],
  ])
    refused(await invoke(args));
});

test("a valid file followed by a directory still refuses the whole command before HOME", async () => {
  refused(
    await invoke(["--test", "one.test.mjs", "packages"], {
      entries: ["one.test.mjs", ["packages", "directory"]],
    }),
  );
});

test("current CI explicit file vectors and finite pattern flags are forwarded byte for byte", async () => {
  const vector = [
    "--test",
    "--test-name-pattern",
    "owned (one|two)",
    "--test-skip-pattern=actual native owned child",
    "one.test.mjs",
    "two.test.mjs",
  ];
  const value = await invoke(vector);
  assert.equal(value.exitCode, undefined);
  assert.deepEqual(value.errors, []);
  const call = value.calls.find(([kind]) => kind === "spawn");
  assert.equal(call[1], "/owned/node");
  assert.deepEqual(Array.from(call[2]), vector);
  assert.equal(call[3].stdio, "inherit");
  assert.equal(call[3].env.OWNED, "/owned/private");
  assert.deepEqual(
    value.calls.map(([kind]) => kind),
    ["lstat", "lstat", "home", "environment", "spawn", "remove"],
  );
});

test("every current workflow Node-test invocation remains a finite explicit vector", async () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/desktop-ui-acceptance.yml", import.meta.url),
    "utf8",
  );
  const vectors = [
    ...workflow.matchAll(
      /node scripts\/run-isolated-node-smoke\.mjs (--test [^\r\n]+?)(?: 2>&1|$)/gm,
    ),
  ].map((match) => match[1].trim().split(/\s+/));
  assert.ok(vectors.length > 0);
  for (const vector of vectors) {
    assert.ok(vector.slice(1).every((path) => path.endsWith(".test.mjs")));
    const value = await invoke(vector, { entries: vector.slice(1) });
    assert.equal(value.exitCode, undefined);
    assert.deepEqual(Array.from(value.calls.find(([kind]) => kind === "spawn")[2]), vector);
  }
});

test("an explicit Unicode or spaced filename is a file, never a discovery pattern", async () => {
  const path = "packages/owned space/报告.test.mjs";
  const value = await invoke(["--test", path], { entries: [path] });
  assert.equal(value.exitCode, undefined);
  assert.deepEqual(Array.from(value.calls.find(([kind]) => kind === "spawn")[2]), ["--test", path]);
});

test("ordinary smoke entries and Linux private-keyring vectors retain the original behavior", async () => {
  const plain = await invoke(["scripts/owned-smoke.mjs", "--evidence-dir", "owned-output"], {
    electron: true,
  });
  const call = plain.calls.find(([kind]) => kind === "spawn");
  assert.deepEqual(Array.from(call[2]), [
    "scripts/owned-smoke.mjs",
    "--evidence-dir",
    "owned-output",
  ]);
  assert.equal(call[3].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(
    plain.calls.some(([kind]) => kind === "lstat"),
    false,
  );
  const linux = await invoke(["--private-keyring", "scripts/owned-smoke.mjs", "--owned"], {
    platform: "linux",
  });
  const keyring = linux.calls.find(([kind]) => kind === "spawn");
  assert.equal(keyring[1], "bash");
  assert.deepEqual(Array.from(keyring[2]), [
    fileURLToPath(new URL("./run-electron-e2e-keyring.sh", url)),
    "/owned/node",
    "scripts/owned-smoke.mjs",
    "--owned",
  ]);
});

test("bounded explicit lists cannot turn into an unreviewed mass invocation", async () => {
  const entries = Array.from({ length: 129 }, (_, index) => `owned-${index}.test.mjs`);
  const accepted = await invoke(["--test", ...entries.slice(0, 128)], { entries });
  assert.equal(accepted.exitCode, undefined);
  refused(await invoke(["--test", ...entries], { entries }));
});

test("existing child failure and error paths retain final HOME cleanup", async () => {
  for (const options of [
    { close: { code: 1, signal: null } },
    { close: { code: null, signal: "SIGTERM" } },
    { spawnError: Error("inert spawn rejected") },
  ]) {
    const value = await invoke(["--test", "one.test.mjs"], options);
    assert.equal(value.exitCode, 1);
    assert.equal(value.errors.length, 1);
    assert.equal(value.calls.at(-1)[0], "remove");
  }
});
