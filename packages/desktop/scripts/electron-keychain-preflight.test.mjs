import { deepStrictEqual, equal, match, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureElectronKeychainContext } from "./electron-keychain-preflight.mjs";
import { keychainPreferenceXml } from "./macos-keychain-context.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const testPosix = (name, run) =>
  test(
    name,
    { skip: process.platform === "win32" ? "Requires POSIX mode/owner checks" : false },
    run,
  );

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "electron-keychain-preflight-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "private-home");
  const operatorHome = join(root, "account-home");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(operatorHome, { mode: 0o700 });
  const metadata = {
    path: "/metadata/existing-login.keychain-db",
    pathHash: hash("/metadata/existing-login.keychain-db"),
    dev: 1,
    ino: 2,
    uid: process.getuid(),
  };
  const reference = { version: 1, home: operatorHome, ...metadata };
  const calls = [];
  const input = {
    home,
    operatorHome,
    platform: "darwin",
    environment: { HOME: home, USERPROFILE: home },
    query(contextHome) {
      calls.push(contextHome);
      if (contextHome === home)
        equal(
          readFileSync(join(home, "Library", "Preferences", "com.apple.security.plist"), "utf8"),
          keychainPreferenceXml(metadata.path),
        );
      else equal(contextHome, operatorHome);
      return metadata;
    },
  };
  return {
    ...input,
    root,
    input,
    metadata,
    reference,
    calls,
    referenceFile: join(home, "electron-keychain-reference.json"),
    receiptFile: join(home, "electron-keychain-context.json"),
    preferenceFile: join(home, "Library", "Preferences", "com.apple.security.plist"),
  };
}

function explicitReference(f) {
  const file = join(f.root, "explicit-reference.json");
  writeFileSync(file, JSON.stringify(f.reference), { mode: 0o600 });
  f.input.environment.CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE = file;
  return file;
}

function existingPreference(f, xml = keychainPreferenceXml(f.metadata.path)) {
  mkdirSync(join(f.home, "Library"), { mode: 0o700 });
  mkdirSync(join(f.home, "Library", "Preferences"), { mode: 0o700 });
  writeFileSync(f.preferenceFile, xml, { mode: 0o600 });
}

function assertPreflightFailure(action, causePattern) {
  throws(action, (error) => {
    match(error.message, /macOS Keychain preflight failed.*Electron was not started/);
    if (causePattern) match(error.cause.message, causePattern);
    return true;
  });
}

test("non-macOS launches do not query or write Keychain metadata", () => {
  equal(
    ensureElectronKeychainContext({
      home: "/does-not-exist",
      operatorHome: "/also-does-not-exist",
      platform: "linux",
      query() {
        throw new Error("must not run");
      },
    }),
    null,
  );
});

testPosix(
  "fresh isolated HOME gets only a verified default reference and private pinned metadata",
  (t) => {
    const f = fixture(t);
    const result = ensureElectronKeychainContext(f.input);
    equal(result.reused, false);
    deepStrictEqual(f.calls, [f.operatorHome, f.operatorHome, f.home, f.operatorHome]);
    deepStrictEqual(JSON.parse(readFileSync(f.referenceFile, "utf8")), f.reference);
    for (const file of [f.referenceFile, f.receiptFile, f.preferenceFile])
      equal(statSync(file).mode & 0o777, 0o600);
    equal(statSync(f.referenceFile).size <= 4_096, true);
    equal(statSync(f.preferenceFile).size <= 1_024, true);
    equal(existsSync(join(f.operatorHome, "Library")), false);
    equal(readFileSync(f.receiptFile, "utf8").includes(f.metadata.path), false);
  },
);

testPosix("cold restart rechecks before/private/after without rewriting any metadata", (t) => {
  const f = fixture(t);
  ensureElectronKeychainContext(f.input);
  const originals = [f.referenceFile, f.receiptFile, f.preferenceFile].map((file) =>
    readFileSync(file),
  );
  const originalStats = [f.referenceFile, f.receiptFile, f.preferenceFile].map((file) =>
    statSync(file),
  );
  f.calls.length = 0;
  equal(ensureElectronKeychainContext(f.input).reused, true);
  deepStrictEqual(f.calls, [f.operatorHome, f.home, f.operatorHome]);
  [f.referenceFile, f.receiptFile, f.preferenceFile].forEach((file, index) => {
    deepStrictEqual(readFileSync(file), originals[index]);
    equal(statSync(file).mtimeMs, originalStats[index].mtimeMs);
    equal(statSync(file).ino, originalStats[index].ino);
  });
});

testPosix("a new controller process reuses the on-disk pinned identity", (t) => {
  const f = fixture(t);
  ensureElectronKeychainContext(f.input);
  const source = `import { ensureElectronKeychainContext } from ${JSON.stringify(new URL("./electron-keychain-preflight.mjs", import.meta.url).href)};
const [home, operatorHome, metadata] = process.argv.slice(1);
const calls = [];
const result = ensureElectronKeychainContext({ home, operatorHome, platform: "darwin", environment: { HOME: home, USERPROFILE: home }, query(value) { calls.push(value); return JSON.parse(metadata); } });
process.stdout.write(JSON.stringify({ reused: result.reused, calls }));`;
  const child = spawnSync(
    process.versions.bun ? "node" : process.execPath,
    ["--input-type=module", "-e", source, f.home, f.operatorHome, JSON.stringify(f.metadata)],
    { encoding: "utf8", timeout: 10_000 },
  );
  equal(child.status, 0, child.stderr);
  deepStrictEqual(JSON.parse(child.stdout), {
    reused: true,
    calls: [f.operatorHome, f.home, f.operatorHome],
  });
});

testPosix("explicit native-acceptance reference works before any fresh private query", (t) => {
  const f = fixture(t);
  explicitReference(f);
  ensureElectronKeychainContext(f.input);
  deepStrictEqual(f.calls, [f.operatorHome, f.home, f.operatorHome]);
});

testPosix("default account discovery ignores a scrubbed process HOME", (t) => {
  const f = fixture(t);
  const accountHome = realpathSync(userInfo().homedir);
  const calls = [];
  ensureElectronKeychainContext({
    home: f.home,
    environment: f.environment,
    platform: "darwin",
    query(contextHome) {
      calls.push(contextHome);
      return f.metadata;
    },
  });
  deepStrictEqual(calls, [accountHome, accountHome, f.home, accountHome]);
  equal(JSON.parse(readFileSync(f.referenceFile, "utf8")).home, accountHome);
});

testPosix(
  "canonical manual native-acceptance binding is adopted without touching its receipt",
  (t) => {
    const f = fixture(t);
    explicitReference(f);
    existingPreference(f);
    const oldReceipt = join(f.root, "native-acceptance-receipt.json");
    writeFileSync(oldReceipt, "preserved native evidence\n", { mode: 0o600 });
    const originalPreference = statSync(f.preferenceFile);
    equal(ensureElectronKeychainContext(f.input).reused, false);
    deepStrictEqual(f.calls, [f.operatorHome, f.home, f.operatorHome]);
    equal(readFileSync(oldReceipt, "utf8"), "preserved native evidence\n");
    equal(statSync(f.preferenceFile).ino, originalPreference.ino);
    equal(statSync(f.preferenceFile).mtimeMs, originalPreference.mtimeMs);
    deepStrictEqual(JSON.parse(readFileSync(f.referenceFile, "utf8")), f.reference);
  },
);

testPosix(
  "an existing preference without a pinned or explicit reference is refused unchanged",
  (t) => {
    const f = fixture(t);
    existingPreference(f);
    assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /explicit/);
    equal(f.calls.length, 0);
    equal(existsSync(f.referenceFile), false);
    equal(existsSync(f.receiptFile), false);
  },
);

testPosix(
  "foreign existing preferences are never overwritten even with an explicit reference",
  (t) => {
    const f = fixture(t);
    explicitReference(f);
    existingPreference(f, "unrecognized preference\n");
    assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /canonical/);
    equal(readFileSync(f.preferenceFile, "utf8"), "unrecognized preference\n");
    equal(existsSync(f.referenceFile), false);
    equal(existsSync(f.receiptFile), false);
  },
);

testPosix("missing original default fails before any private preference is created", (t) => {
  const f = fixture(t);
  assertPreflightFailure(
    () =>
      ensureElectronKeychainContext({
        ...f.input,
        query() {
          throw new Error("no existing default");
        },
      }),
    /no existing default/,
  );
  equal(existsSync(join(f.home, "Library")), false);
  equal(existsSync(f.referenceFile), false);
  equal(existsSync(f.receiptFile), false);
});

testPosix("stale explicit identity is refused before a preference can be written", (t) => {
  const f = fixture(t);
  explicitReference(f);
  assertPreflightFailure(
    () => ensureElectronKeychainContext({ ...f.input, query: () => ({ ...f.metadata, ino: 3 }) }),
    /changed/,
  );
  equal(existsSync(join(f.home, "Library")), false);
  equal(existsSync(f.referenceFile), false);
});

testPosix(
  "each cold-start identity check rejects changed metadata and leaves evidence intact",
  (t) => {
    for (const changedCall of [1, 2, 3]) {
      const f = fixture(t);
      ensureElectronKeychainContext(f.input);
      const original = readFileSync(f.referenceFile, "utf8");
      let calls = 0;
      assertPreflightFailure(
        () =>
          ensureElectronKeychainContext({
            ...f.input,
            query: () => (++calls === changedCall ? { ...f.metadata, ino: 3 } : f.metadata),
          }),
        /changed|differs/,
      );
      equal(readFileSync(f.referenceFile, "utf8"), original);
    }
  },
);

testPosix("explicit reference cannot replace a different pinned cold-start identity", (t) => {
  const f = fixture(t);
  ensureElectronKeychainContext(f.input);
  const explicit = explicitReference(f);
  writeFileSync(explicit, JSON.stringify({ ...f.reference, ino: 3 }));
  f.calls.length = 0;
  assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /disagree/);
  equal(f.calls.length, 0);
});

testPosix("final HOME and USERPROFILE overrides cannot escape the checked fixture", (t) => {
  for (const changed of [
    { HOME: undefined },
    { HOME: "/different" },
    { USERPROFILE: "/different" },
  ]) {
    const f = fixture(t);
    assertPreflightFailure(
      () =>
        ensureElectronKeychainContext({
          ...f.input,
          environment: { ...f.environment, ...changed },
        }),
      /final Electron HOME/,
    );
    equal(f.calls.length, 0);
    equal(existsSync(join(f.home, "Library")), false);
  }
});

testPosix("account HOME and symlinked fixture HOME cannot be mutated", (t) => {
  const f = fixture(t);
  assertPreflightFailure(
    () =>
      ensureElectronKeychainContext({
        ...f.input,
        home: f.operatorHome,
        environment: { HOME: f.operatorHome },
      }),
    /account HOME/,
  );
  const alias = join(f.root, "home-link");
  symlinkSync(f.home, alias);
  assertPreflightFailure(
    () => ensureElectronKeychainContext({ ...f.input, home: alias, environment: { HOME: alias } }),
    /symlinks/,
  );
  equal(existsSync(join(f.operatorHome, "Library")), false);
});

testPosix("preference directory symlinks are refused without following them", (t) => {
  for (const location of ["Library", "Preferences"]) {
    const f = fixture(t);
    if (location === "Preferences") mkdirSync(join(f.home, "Library"), { mode: 0o700 });
    const target =
      location === "Library" ? join(f.home, "Library") : join(f.home, "Library", "Preferences");
    symlinkSync(f.operatorHome, target);
    assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /real, owned/);
    equal(f.calls.length, 0);
    equal(existsSync(join(f.operatorHome, "com.apple.security.plist")), false);
  }
});

testPosix("metadata file symlinks and permissive modes cannot authorize reuse", (t) => {
  for (const kind of ["reference", "preference", "receipt"]) {
    for (const violation of ["symlink", "mode"]) {
      const f = fixture(t);
      ensureElectronKeychainContext(f.input);
      const file =
        kind === "reference"
          ? f.referenceFile
          : kind === "preference"
            ? f.preferenceFile
            : f.receiptFile;
      if (violation === "mode") chmodSync(file, 0o644);
      else {
        const target = join(f.root, `${kind}-target`);
        writeFileSync(target, readFileSync(file), { mode: 0o600 });
        rmSync(file);
        symlinkSync(target, file);
      }
      assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /symlinks|regular file/);
    }
  }
});

testPosix("private HOME and preference directories must keep mode 0700", (t) => {
  for (const location of ["home", "Library", "Preferences"]) {
    const f = fixture(t);
    if (location !== "home") existingPreference(f);
    chmodSync(
      location === "home"
        ? f.home
        : location === "Library"
          ? join(f.home, "Library")
          : join(f.home, "Library", "Preferences"),
      0o755,
    );
    assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /0700/);
    equal(f.calls.length, 0);
  }
});

testPosix("oversized metadata and altered canonical preferences are rejected before reuse", (t) => {
  for (const kind of ["reference", "preference"]) {
    const f = fixture(t);
    ensureElectronKeychainContext(f.input);
    writeFileSync(
      kind === "reference" ? f.referenceFile : f.preferenceFile,
      " ".repeat(kind === "reference" ? 4_097 : 1_025),
    );
    assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /bounded/);
  }
  const f = fixture(t);
  ensureElectronKeychainContext(f.input);
  writeFileSync(f.preferenceFile, keychainPreferenceXml("/metadata/different.keychain-db"));
  assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /canonical/);
});

testPosix(
  "unrelated receipt or missing pinned preference cannot be overwritten or recreated",
  (t) => {
    const f = fixture(t);
    writeFileSync(f.receiptFile, "existing receipt\n", { mode: 0o600 });
    assertPreflightFailure(
      () => ensureElectronKeychainContext(f.input),
      /receipts cannot be overwritten/,
    );
    equal(readFileSync(f.receiptFile, "utf8"), "existing receipt\n");
    equal(existsSync(join(f.home, "Library")), false);
    rmSync(f.receiptFile);
    ensureElectronKeychainContext(f.input);
    rmSync(f.preferenceFile);
    assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /missing/);
    equal(existsSync(f.preferenceFile), false);
  },
);

testPosix(
  "a reference captured from a scrubbed fixture cannot substitute for the original account",
  (t) => {
    const f = fixture(t);
    const file = explicitReference(f);
    writeFileSync(file, JSON.stringify({ ...f.reference, home: f.home }));
    assertPreflightFailure(() => ensureElectronKeychainContext(f.input), /original account/);
    equal(f.calls.length, 0);
  },
);

testPosix("malformed or non-private explicit reference cannot create fixture metadata", (t) => {
  for (const violation of ["malformed", "directory", "mode", "empty"]) {
    const f = fixture(t);
    const file = explicitReference(f);
    if (violation === "malformed") writeFileSync(file, "{broken");
    if (violation === "directory") {
      rmSync(file);
      mkdirSync(file, { mode: 0o700 });
    }
    if (violation === "mode") chmodSync(file, 0o644);
    if (violation === "empty") f.input.environment.CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE = "";
    assertPreflightFailure(() => ensureElectronKeychainContext(f.input));
    equal(f.calls.length, 0);
    equal(existsSync(join(f.home, "Library")), false);
    equal(existsSync(f.referenceFile), false);
  }
});
