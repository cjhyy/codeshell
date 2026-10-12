import { equal, match, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchCodeShellElectron, makeIsolatedElectronHome } from "./electron-harness.mjs";
import { ensureElectronKeychainContext } from "./electron-keychain-preflight.mjs";
import { keychainPreferenceXml } from "./macos-keychain-context.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "electron-launch-preflight-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const operatorHome = join(root, "operator");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(operatorHome, { mode: 0o700 });
  return { home, operatorHome, appDir: root };
}

test("missing macOS default fails before bootstrap or Electron launch", async (t) => {
  const input = fixture(t);
  let launches = 0;
  await rejects(
    launchCodeShellElectron(input, {
      preflight: (options) =>
        ensureElectronKeychainContext({
          ...options,
          platform: "darwin",
          operatorHome: input.operatorHome,
          query: () => {
            throw new Error("synthetic missing default");
          },
        }),
      launch: () => {
        launches++;
      },
    }),
    /Keychain preflight.*Electron was not started/,
  );
  equal(launches, 0);
  equal(existsSync(join(input.home, "real-keyring.cjs")), false);
});

test("HOME overrides cannot bypass preflight and reach Electron", async (t) => {
  const input = fixture(t);
  for (const key of ["HOME", "USERPROFILE"]) {
    let launches = 0;
    await rejects(
      launchCodeShellElectron(
        { ...input, env: { [key]: input.operatorHome } },
        {
          preflight: (options) =>
            ensureElectronKeychainContext({
              ...options,
              platform: "darwin",
              operatorHome: input.operatorHome,
              query: () => {
                throw new Error("must not query mismatched HOME");
              },
            }),
          launch: () => {
            launches++;
          },
        },
      ),
      /Keychain preflight.*Electron was not started/,
    );
    equal(launches, 0);
    equal(existsSync(join(input.home, "real-keyring.cjs")), false);
  }
});

test("launch validates merged environment first and attaches a bounded watchdog", async (t) => {
  const input = fixture(t);
  const order = [];
  const child = { pid: 123 };
  const application = { process: () => child };
  const result = await launchCodeShellElectron(
    { ...input, env: { CODE_SHELL_NO_DEVTOOLS: "fixture" }, runtimeTimeoutMs: 12_345 },
    {
      preflight(options) {
        order.push("preflight");
        equal(options.environment.HOME, input.home);
        equal(options.environment.USERPROFILE, input.home);
        equal(options.environment.CODE_SHELL_NO_DEVTOOLS, "fixture");
        equal(existsSync(join(input.home, "real-keyring.cjs")), false);
      },
      async launch(options) {
        order.push("launch");
        equal(options.timeout, 30_000);
        equal(options.env.HOME, input.home);
        equal(existsSync(join(input.home, "real-keyring.cjs")), true);
        match(options.args[2], /^--user-data-dir=/);
        return application;
      },
      watch(actualChild, options) {
        order.push("watch");
        equal(actualChild, child);
        equal(options.timeoutMs, 12_345);
      },
    },
  );
  equal(order.join(), "preflight,launch,watch");
  equal(result, application);
});

test(
  "confined acceptance preserves its parent reference for preflight while scrubbing the child",
  { skip: process.platform === "win32" ? "Requires POSIX metadata ownership" : false },
  async (t) => {
    const input = fixture(t);
    const metadata = {
      path: "/metadata/existing-login.keychain-db",
      pathHash: createHash("sha256").update("/metadata/existing-login.keychain-db").digest("hex"),
      dev: 1,
      ino: 2,
      uid: process.getuid(),
    };
    const referenceFile = join(input.appDir, "explicit-reference.json");
    writeFileSync(
      referenceFile,
      JSON.stringify({ version: 1, home: input.operatorHome, ...metadata }),
      { mode: 0o600 },
    );
    const preferences = join(input.home, "Library", "Preferences");
    mkdirSync(preferences, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(preferences, "com.apple.security.plist"),
      keychainPreferenceXml(metadata.path),
      {
        mode: 0o600,
      },
    );
    const key = "CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE";
    const previous = process.env[key];
    process.env[key] = referenceFile;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    let launches = 0;
    await launchCodeShellElectron(
      { ...input, env: { [key]: undefined } },
      {
        preflight: (options) =>
          ensureElectronKeychainContext({
            ...options,
            platform: "darwin",
            operatorHome: input.operatorHome,
            query: () => metadata,
          }),
        launch: async (options) => {
          launches++;
          equal(options.env[key], undefined);
          return { process: () => ({}) };
        },
        watch: () => {},
      },
    );
    equal(launches, 1);
    equal(existsSync(join(input.home, "electron-keychain-reference.json")), true);
  },
);

test("invalid deadlines refuse launch and watcher setup failure closes only its app", async (t) => {
  const input = fixture(t);
  for (const options of [
    { timeout: 0 },
    { runtimeTimeoutMs: Infinity },
    { runtimeTimeoutMs: 2_147_483_648 },
  ]) {
    await rejects(
      launchCodeShellElectron(
        { ...input, ...options },
        {
          preflight: () => {
            throw new Error("must validate deadline first");
          },
        },
      ),
      /positive safe integer/,
    );
  }
  let closed = 0;
  await rejects(
    launchCodeShellElectron(input, {
      preflight: () => {},
      launch: async () => ({
        process: () => ({}),
        close: async () => {
          closed++;
        },
      }),
      watch: () => {
        throw new Error("synthetic watchdog failure");
      },
    }),
    /synthetic watchdog failure/,
  );
  equal(closed, 1);
});

test("temporary Electron homes are canonical and cleanup stays scoped to that fixture", async () => {
  const isolated = await makeIsolatedElectronHome("electron-home-canonical-test-");
  try {
    equal(isolated.home, realpathSync(isolated.home));
    equal(isolated.codeShellHome, join(isolated.home, ".code-shell"));
  } finally {
    await isolated.cleanup();
  }
  equal(existsSync(isolated.home), false);
});
