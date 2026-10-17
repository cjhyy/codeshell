import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const referenceName = "keyring-reference.json";
const pidValid = (pid) => Number.isSafeInteger(pid) && pid > 0;
const unixAddress = (address) =>
  typeof address === "string" &&
  /^unix:(?:path|abstract)=[^,;\r\n\0]+(?:,guid=[a-f0-9]{32})?$/.test(address);

function processIdentity(pid) {
  assert.ok(pidValid(pid), "Invalid Linux process identity");
  const root = `/proc/${pid}`;
  const stat = readFileSync(join(root, "stat"), "utf8");
  assert.ok(stat.length <= 4096, "Oversized Linux process identity");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  assert.ok(/^\d+$/.test(fields[19]), "Invalid Linux process start time");
  const cmdline = readFileSync(join(root, "cmdline"), "utf8");
  assert.ok(cmdline.length <= 16_384, "Oversized Linux process command");
  return {
    pid,
    ppid: Number(fields[1]),
    startTicks: fields[19],
    uid: lstatSync(root).uid,
    executable: realpathSync(join(root, "exe")),
    argv: cmdline.split("\0").filter(Boolean),
  };
}

function servicePid(address, name) {
  assert.ok(unixAddress(address), "Private Linux keyring requires one Unix D-Bus address");
  assert.ok(["org.freedesktop.DBus", "org.freedesktop.secrets"].includes(name));
  const reply = execFileSync(
    "/usr/bin/dbus-send",
    [
      "--session",
      "--reply-timeout=1500",
      "--type=method_call",
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/",
      "org.freedesktop.DBus.GetConnectionUnixProcessID",
      `string:${name}`,
    ],
    {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", DBUS_SESSION_BUS_ADDRESS: address },
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
    },
  );
  const matches = [...reply.matchAll(/^\s*uint32\s+(\d+)\s*$/gm)];
  assert.equal(matches.length, 1, "Invalid private D-Bus process reply");
  const pid = Number(matches[0][1]);
  assert.ok(pidValid(pid), "Invalid private D-Bus process PID");
  return pid;
}

function privateDirectory(path, uid) {
  const info = lstatSync(path);
  assert.ok(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === uid &&
      (info.mode & 0o777) === 0o700 &&
      realpathSync(path) === path,
    "Linux keyring directories must be real, owned and mode 0700",
  );
}

function verifyReference(reference, file, { inspectProcess, queryServicePid, currentPid, uid }) {
  assert.ok(
    reference &&
      reference.schemaVersion === 1 &&
      reference.kind === "codeshell-owned-linux-keyring",
    "Invalid Linux keyring reference schema",
  );
  assert.deepEqual(
    Object.keys(reference).sort(),
    [
      "schemaVersion",
      "kind",
      "uid",
      "busAddress",
      "runtimeDirectory",
      "controlDirectory",
      "wrapper",
      "session",
      "bus",
      "daemon",
    ].sort(),
    "Unexpected Linux keyring reference fields",
  );
  assert.equal(reference.uid, uid, "Foreign Linux keyring owner");
  const root = dirname(file);
  assert.ok(
    basename(root).startsWith("codeshell-linux-keyring-"),
    "Foreign Linux keyring directory",
  );
  privateDirectory(root, uid);
  assert.equal(reference.runtimeDirectory, join(root, "runtime"), "Foreign Linux keyring runtime");
  assert.equal(
    reference.controlDirectory,
    join(root, "runtime", "keyring"),
    "Foreign Linux keyring control",
  );
  privateDirectory(reference.runtimeDirectory, uid);
  privateDirectory(reference.controlDirectory, uid);
  assert.ok(
    unixAddress(reference.busAddress),
    "Private Linux keyring requires one Unix D-Bus address",
  );
  const processes = {};
  for (const role of ["wrapper", "session", "bus", "daemon"]) {
    const recorded = reference[role];
    assert.ok(
      recorded &&
        pidValid(recorded.pid) &&
        typeof recorded.startTicks === "string" &&
        /^\d+$/.test(recorded.startTicks),
      "Missing Linux keyring process identity",
    );
    assert.deepEqual(
      Object.keys(recorded).sort(),
      ["pid", "startTicks"],
      "Unexpected Linux process reference fields",
    );
    const actual = inspectProcess(recorded.pid);
    assert.ok(
      actual.pid === recorded.pid &&
        actual.uid === uid &&
        actual.startTicks === recorded.startTicks,
      "Linux keyring process identity changed",
    );
    processes[role] = actual;
  }
  const { wrapper, session, bus, daemon } = processes;
  assert.ok(
    new Set([wrapper.pid, session.pid, bus.pid, daemon.pid]).size === 4,
    "Overlapping Linux keyring process identities",
  );
  assert.equal(session.executable, "/usr/bin/dbus-run-session", "Foreign Linux D-Bus supervisor");
  assert.equal(bus.executable, "/usr/bin/dbus-daemon", "Foreign Linux D-Bus daemon");
  assert.equal(
    daemon.executable,
    "/usr/bin/gnome-keyring-daemon",
    "Foreign Linux SecretService executable",
  );
  assert.ok(
    wrapper.ppid === session.pid && bus.ppid === session.pid && daemon.ppid === wrapper.pid,
    "Linux keyring processes do not belong to this private session",
  );
  assert.ok(
    daemon.argv.includes("--foreground") &&
      daemon.argv.includes("--components=secrets") &&
      daemon.argv.includes(`--control-directory=${reference.controlDirectory}`),
    "Foreign Linux SecretService command",
  );
  let ancestor = currentPid;
  const seen = new Set();
  while (ancestor !== wrapper.pid && pidValid(ancestor) && !seen.has(ancestor) && seen.size < 64) {
    seen.add(ancestor);
    ancestor = inspectProcess(ancestor).ppid;
  }
  assert.equal(ancestor, wrapper.pid, "Linux keyring wrapper does not own the current fixture");
  assert.equal(
    queryServicePid(reference.busAddress, "org.freedesktop.DBus"),
    bus.pid,
    "Private D-Bus PID changed",
  );
  assert.equal(
    queryServicePid(reference.busAddress, "org.freedesktop.secrets"),
    daemon.pid,
    "Private SecretService PID changed",
  );
  for (const role of ["bus", "daemon"]) {
    const current = inspectProcess(processes[role].pid);
    assert.ok(
      current.uid === uid && current.startTicks === processes[role].startTicks,
      "Linux keyring process identity changed during bus verification",
    );
  }
  return {
    DBUS_SESSION_BUS_ADDRESS: reference.busAddress,
    DBUS_SESSION_BUS_PID: String(bus.pid),
    GNOME_KEYRING_CONTROL: reference.controlDirectory,
    GNOME_KEYRING_PID: String(daemon.pid),
    XDG_RUNTIME_DIR: reference.runtimeDirectory,
    XDG_CURRENT_DESKTOP: "GNOME",
  };
}

/** Read process and bus metadata only. Never reads a SecretService item or
 * password, and never falls back to the caller's existing session bus. */
export function readPackagedLinuxEnvironment(
  {
    referenceFile = process.env.CODESHELL_LINUX_KEYRING_REFERENCE,
    environment = process.env,
    platform = process.platform,
  } = {},
  {
    inspectProcess = processIdentity,
    queryServicePid = servicePid,
    currentPid = process.pid,
    uid = process.getuid?.(),
  } = {},
) {
  assert.equal(platform, "linux", "Packaged Linux environment requires Linux");
  assert.ok(
    typeof referenceFile === "string" && isAbsolute(referenceFile),
    "Owned Linux keyring reference is required",
  );
  assert.equal(
    realpathSync(referenceFile),
    resolve(referenceFile),
    "Linux keyring reference cannot traverse symlinks",
  );
  assert.equal(basename(referenceFile), referenceName, "Foreign Linux keyring reference name");
  const descriptor = openSync(referenceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let reference;
  try {
    const info = fstatSync(descriptor);
    assert.ok(
      info.isFile() &&
        info.uid === uid &&
        info.nlink === 1 &&
        (info.mode & 0o777) === 0o600 &&
        info.size > 0 &&
        info.size <= 4096,
      "Linux keyring reference must be bounded, owned and mode 0600",
    );
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    assert.ok(length <= 4096, "Linux keyring reference grew beyond its bound");
    reference = JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(descriptor);
  }
  const verified = verifyReference(reference, referenceFile, {
    inspectProcess,
    queryServicePid,
    currentPid,
    uid,
  });
  if (environment.DISPLAY) {
    assert.ok(
      /^:\d+(?:\.\d+)?$/.test(environment.DISPLAY),
      "Packaged Linux requires a local X11 display",
    );
    verified.DISPLAY = environment.DISPLAY;
  }
  if (environment.XAUTHORITY) {
    assert.ok(
      isAbsolute(environment.XAUTHORITY) && !/[\r\n\0]/.test(environment.XAUTHORITY),
      "Invalid Linux XAUTHORITY path",
    );
    verified.XAUTHORITY = environment.XAUTHORITY;
  }
  return verified;
}

function captureReference(file, wrapperPid, daemonPid) {
  assert.equal(process.platform, "linux", "Keyring reference capture requires Linux");
  const uid = process.getuid();
  const wrapper = processIdentity(wrapperPid);
  const session = processIdentity(wrapper.ppid);
  const daemon = processIdentity(daemonPid);
  const bus = processIdentity(
    servicePid(process.env.DBUS_SESSION_BUS_ADDRESS, "org.freedesktop.DBus"),
  );
  const identity = ({ pid, startTicks }) => ({ pid, startTicks });
  const reference = {
    schemaVersion: 1,
    kind: "codeshell-owned-linux-keyring",
    uid,
    busAddress: process.env.DBUS_SESSION_BUS_ADDRESS,
    runtimeDirectory: process.env.XDG_RUNTIME_DIR,
    controlDirectory: process.env.GNOME_KEYRING_CONTROL,
    wrapper: identity(wrapper),
    session: identity(session),
    bus: identity(bus),
    daemon: identity(daemon),
  };
  assert.equal(resolve(file), join(dirname(reference.runtimeDirectory), referenceName));
  verifyReference(reference, file, {
    inspectProcess: processIdentity,
    queryServicePid: servicePid,
    currentPid: process.pid,
    uid,
  });
  const bytes = JSON.stringify(reference) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= 4096);
  writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, file, wrapperFlag, wrapperPid, daemonFlag, daemonPid, ...rest] =
    process.argv.slice(2);
  assert.ok(
    mode === "--capture" &&
      file &&
      wrapperFlag === "--wrapper-pid" &&
      daemonFlag === "--daemon-pid" &&
      !rest.length,
    "Expected --capture <reference> --wrapper-pid <PID> --daemon-pid <PID>",
  );
  captureReference(resolve(file), Number(wrapperPid), Number(daemonPid));
}
