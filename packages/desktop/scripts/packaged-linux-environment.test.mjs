import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackagedLinuxEnvironment } from "./packaged-linux-environment.mjs";

// Native Windows does not supply POSIX owner/mode metadata; the helper itself
// refuses that platform. These are POSIX fixture tests, not Linux runtime proof.
const fixtureTest = test.skipIf(process.platform === "win32");

function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-linux-keyring-test-")));
  const runtime = join(root, "runtime");
  const control = join(runtime, "keyring");
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(control, { mode: 0o700 });
  const file = join(root, "keyring-reference.json");
  const uid = process.getuid();
  const fixtureProcess = (pid, ppid, executable, argv = []) => ({
    pid,
    ppid,
    uid,
    startTicks: String(pid * 100),
    executable,
    argv,
  });
  const identities = new Map([
    [100, fixtureProcess(100, 90, "/usr/bin/dbus-run-session")],
    [101, fixtureProcess(101, 100, "/usr/bin/dbus-daemon")],
    [200, fixtureProcess(200, 100, "/usr/bin/bash")],
    [
      201,
      fixtureProcess(201, 200, "/usr/bin/gnome-keyring-daemon", [
        "gnome-keyring-daemon",
        "--foreground",
        "--unlock",
        "--components=secrets",
        `--control-directory=${control}`,
      ]),
    ],
    [300, fixtureProcess(300, 200, "/usr/bin/node")],
  ]);
  const identity = (pid) => ({ pid, startTicks: identities.get(pid).startTicks });
  const reference = {
    schemaVersion: 1,
    kind: "codeshell-owned-linux-keyring",
    uid,
    busAddress: "unix:path=/tmp/owned-dbus-fixture,guid=0123456789abcdef0123456789abcdef",
    runtimeDirectory: runtime,
    controlDirectory: control,
    wrapper: identity(200),
    session: identity(100),
    bus: identity(101),
    daemon: identity(201),
  };
  const queries = [];
  const dependencies = {
    uid,
    currentPid: 300,
    inspectProcess: (pid) => {
      if (!identities.has(pid)) throw Error("Unknown fixture process");
      return identities.get(pid);
    },
    queryServicePid: (address, service) => {
      queries.push({ address, service });
      return service === "org.freedesktop.secrets" ? 201 : 101;
    },
  };
  const put = (value = reference) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const read = (environment = {}) =>
    readPackagedLinuxEnvironment(
      { referenceFile: file, environment, platform: "linux" },
      dependencies,
    );
  put();
  try {
    run({ root, file, reference, identities, dependencies, queries, put, read });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

fixtureTest(
  "fixture parsing selects only the verified private bus/runtime and local display, never caller Host state",
  () =>
    fixture(({ reference, queries, read }) => {
      const result = read({
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/operator/bus",
        GNOME_KEYRING_CONTROL: "/operator/keyring",
        HOME: "/operator/home",
        XDG_CONFIG_HOME: "/operator/config",
        DISPLAY: ":99",
        XAUTHORITY: "/owned/xvfb/Xauthority",
      });
      expect(result).toEqual({
        DBUS_SESSION_BUS_ADDRESS: reference.busAddress,
        DBUS_SESSION_BUS_PID: "101",
        GNOME_KEYRING_CONTROL: reference.controlDirectory,
        GNOME_KEYRING_PID: "201",
        XDG_RUNTIME_DIR: reference.runtimeDirectory,
        XDG_CURRENT_DESKTOP: "GNOME",
        DISPLAY: ":99",
        XAUTHORITY: "/owned/xvfb/Xauthority",
      });
      expect(queries).toEqual([
        { address: reference.busAddress, service: "org.freedesktop.DBus" },
        { address: reference.busAddress, service: "org.freedesktop.secrets" },
      ]);
    }),
);

test("no reference and non-Linux invocation refuse without falling back to an existing bus", () => {
  expect(() =>
    readPackagedLinuxEnvironment({
      platform: "linux",
      referenceFile: null,
      environment: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/operator/bus" },
    }),
  ).toThrow("reference is required");
  expect(() => readPackagedLinuxEnvironment({ platform: "darwin" })).toThrow("requires Linux");
});

fixtureTest("missing, malformed, oversized, public and symlink references are rejected", () =>
  fixture(({ root, file, read, put }) => {
    unlinkSync(file);
    expect(read).toThrow();
    writeFileSync(file, "{broken", { mode: 0o600 });
    expect(read).toThrow();
    writeFileSync(file, " ".repeat(4097));
    expect(read).toThrow("bounded");
    put();
    chmodSync(file, 0o644);
    expect(read).toThrow("mode 0600");
    chmodSync(file, 0o600);
    const alias = join(root, "alias.json");
    symlinkSync(file, alias);
    expect(() => readPackagedLinuxEnvironment({ platform: "linux", referenceFile: alias })).toThrow(
      "symlinks",
    );
  }),
);

fixtureTest(
  "foreign paths, owners, non-private directories and extra reference data are refused before querying a bus",
  () =>
    fixture(({ root, reference, queries, put, read }) => {
      for (const change of [
        { uid: reference.uid + 1 },
        { runtimeDirectory: "/operator/runtime" },
        { controlDirectory: "/operator/keyring" },
        { busAddress: "tcp:host=127.0.0.1,port=1234" },
        { busAddress: "unix:path=/owned;unix:path=/operator" },
        { password: "unexpected-reference-data" },
      ]) {
        put({ ...reference, ...change });
        expect(read).toThrow();
      }
      put();
      chmodSync(root, 0o755);
      expect(read).toThrow("mode 0700");
      expect(queries).toEqual([]);
    }),
);

fixtureTest("PID reuse, foreign daemon command and unrelated fixture ancestry are rejected", () =>
  fixture(({ identities, read }) => {
    const daemon = { ...identities.get(201) };
    for (const change of [
      { startTicks: "new-incarnation" },
      { executable: "/operator/gnome-keyring-daemon" },
      { ppid: 999 },
      { argv: ["--foreground", "--control-directory=/operator/keyring"] },
    ]) {
      identities.set(201, { ...daemon, ...change });
      expect(read).toThrow();
    }
    identities.set(201, daemon);
    identities.set(300, { ...identities.get(300), ppid: 300 });
    expect(read).toThrow("does not own the current fixture");
  }),
);

fixtureTest(
  "the live SecretService and bus PID must still match both recorded process incarnations",
  () =>
    fixture(({ dependencies, read }) => {
      dependencies.queryServicePid = (_address, service) =>
        service === "org.freedesktop.DBus" ? 999 : 201;
      expect(read).toThrow("D-Bus PID changed");
      dependencies.queryServicePid = (_address, service) =>
        service === "org.freedesktop.DBus" ? 101 : 999;
      expect(read).toThrow("SecretService PID changed");
    }),
);

fixtureTest("display forwarding refuses remote transports and malformed authority paths", () =>
  fixture(({ read }) => {
    expect(() => read({ DISPLAY: "operator.example:0" })).toThrow("local X11");
    expect(() => read({ DISPLAY: ":99", XAUTHORITY: "relative-authority" })).toThrow("XAUTHORITY");
  }),
);

fixtureTest(
  "an operator bus in an otherwise well-formed private reference is rejected by the actual bus PID check",
  () =>
    fixture(({ reference, dependencies, queries, put, read }) => {
      put({ ...reference, busAddress: "unix:path=/operator/bus" });
      dependencies.queryServicePid = (address, service) => {
        queries.push({ address, service });
        return 999;
      };
      expect(read).toThrow("D-Bus PID changed");
      expect(queries).toEqual([
        { address: "unix:path=/operator/bus", service: "org.freedesktop.DBus" },
      ]);
    }),
);

fixtureTest("a daemon incarnation changing during metadata queries is refused", () =>
  fixture(({ dependencies, identities, read }) => {
    dependencies.queryServicePid = (_address, service) => {
      if (service === "org.freedesktop.secrets") {
        identities.set(201, { ...identities.get(201), startTicks: "20101" });
        return 201;
      }
      return 101;
    };
    expect(read).toThrow("identity changed during bus verification");
  }),
);
