import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  BackgroundServiceStore,
  identityStatus,
  identityGroupStatus,
  upgradeLocalServiceIdentity,
  parseLinuxProcessStat,
  linuxGroupStatus,
  createMachineIdentityReader,
  type CommitBoundary,
  type ServiceProcessIdentity,
} from "./background-service-store.js";

const local = { host: "renamed-local", boot: "boot-current", machine: "machine-local" };
const current = { ...local, pid: process.pid, start: "linux-ticks:42" };
const identities = {
  current: () => current,
  status: (identity: ServiceProcessIdentity) => identityStatus(identity, () => current, local),
};

test("machine inspection backs off 60 seconds after failure completion and caches success for life", () => {
  let clock = 0,
    calls = 0;
  const uuid = "01234567-89AB-CDEF-0123-456789ABCDEF";
  const read = createMachineIdentityReader(
    () => {
      calls++;
      if (calls === 1) {
        clock += 2000; // OS timeout consumes time before the failure backoff starts.
        throw Error("inspection timed out");
      }
      return calls === 2 ? "invalid-machine-id" : uuid;
    },
    "darwin",
    () => clock,
  );
  expect(read()).toBeUndefined();
  const tickValues = [];
  for (clock = 2000; clock < 62000; clock += 1000) tickValues.push(read(), read());
  clock = 61999;
  tickValues.push(read());
  expect(tickValues.every((value) => value === undefined)).toBe(true);
  expect(calls).toBe(1);
  let groupInspections = 0;
  expect(
    identityGroupStatus({ ...current, boot: "previous" }, { ...local, machine: read() }, () => {
      groupInspections++;
      return "dead";
    }),
  ).toBe("unknown");
  expect(groupInspections).toBe(0);
  clock = 62000;
  expect(read()).toBeUndefined();
  expect(calls).toBe(2);
  clock = 121999;
  expect(read()).toBeUndefined();
  expect(calls).toBe(2);
  clock = 122000;
  const expected = createHash("sha256").update(`darwin:${uuid.toLowerCase()}`).digest("hex");
  expect(read()).toBe(expected);
  clock = 1e12;
  expect(read()).toBe(expected);
  expect(calls).toBe(3);
});

test("I4 local boot transition proves death before PGID/EPERM inspection; foreign/shared roots never do", () => {
  let calls = 0;
  const eperm = () => {
    calls++;
    return "unknown" as const;
  };
  expect(identityGroupStatus({ ...current, boot: "previous-boot" }, local, eperm)).toBe("dead");
  expect(calls).toBe(0);
  expect(
    identityGroupStatus(
      { ...current, machine: "foreign-machine", boot: "previous-boot" },
      local,
      eperm,
    ),
  ).toBe("unknown");
  expect(
    identityGroupStatus({ ...current, machine: undefined, boot: "previous-boot" }, local, eperm),
  ).toBe("unknown");
  expect(calls).toBe(0);
  expect(identityGroupStatus({ ...current, host: "old-hostname" }, local, eperm)).toBe("unknown");
  expect(calls).toBe(1);
});

test("I5 boot identity survives hostname changes, never infers remote death from local PID absence", () => {
  expect(identityStatus({ ...current, host: "previous-name" }, () => current, local)).toBe("alive");
  expect(
    identityStatus(
      { ...current, host: "previous-name", start: "linux-ticks:41" },
      () => current,
      local,
    ),
  ).toBe("dead");
  expect(
    identityStatus(
      { ...current, boot: "older" },
      () => {
        throw Error("must not inspect old PID");
      },
      local,
    ),
  ).toBe("dead");
  expect(
    identityStatus({ ...current, pid: 2_000_000_000, machine: "remote" }, () => null, local),
  ).toBe("unknown");
  const legacy = { ...current, machine: undefined };
  const upgraded = upgradeLocalServiceIdentity(legacy, local);
  expect(upgraded.machine).toBe(local.machine);
  expect(upgradeLocalServiceIdentity(upgraded, local)).toBe(upgraded);
  const oldLegacy = { ...legacy, boot: "earlier" };
  expect(upgradeLocalServiceIdentity(oldLegacy, local)).toBe(oldLegacy);
});

for (const boundary of [
  "lock-write",
  "lock-file-fsync",
  "lock-stage-fsync",
  "lock-rename",
  "lock-root-fsync",
] as CommitBoundary[]) {
  test(`I5 lock acquisition remains unavailable across ${boundary} failure and retries exact retained ownership`, () => {
    const root = mkdtempSync(join(tmpdir(), "service-lock-fsync-"));
    let fail = true;
    const observed: CommitBoundary[] = [];
    const store = new BackgroundServiceStore(
      root,
      (point) => {
        observed.push(point);
        if (point === boundary && fail) {
          fail = false;
          throw Error("injected crash boundary");
        }
      },
      identities,
    );
    try {
      expect(() => store.acquire()).toThrow("injected crash boundary");
      expect(store.available()).toBe(false);
      if (["lock-rename", "lock-root-fsync"].includes(boundary)) {
        expect(() => store.recover()).toThrow("SERVICE_COORDINATOR_UNAVAILABLE");
        expect(store.available()).toBe(false);
        const owners = readdirSync(join(root, "coordinator.lock"));
        expect(owners).toHaveLength(1);
        expect(
          JSON.parse(readFileSync(join(root, "coordinator.lock", owners[0]!), "utf8")),
        ).toEqual(current);
        expect(() => new BackgroundServiceStore(root, undefined, identities).acquire()).toThrow(
          "SERVICE_COORDINATOR_BUSY",
        );
        store.acquire();
        expect(readdirSync(join(root, "coordinator.lock"))).toEqual(owners);
      } else {
        expect(existsSync(join(root, "coordinator.lock"))).toBe(false);
        expect(readdirSync(root)).toEqual([]);
        store.acquire();
      }
      expect(store.available()).toBe(true);
      store.release();
      expect(existsSync(join(root, "coordinator.lock"))).toBe(false);
      expect(observed[0]).toBe("lock-write");
    } finally {
      store.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("I5 successful election persists token, stage and root in order", () => {
  const root = mkdtempSync(join(tmpdir(), "service-lock-order-"));
  const order: CommitBoundary[] = [];
  const store = new BackgroundServiceStore(root, (point) => order.push(point), identities);
  try {
    store.acquire();
    expect(order).toEqual([
      "lock-write",
      "lock-file-fsync",
      "lock-stage-fsync",
      "lock-rename",
      "lock-root-fsync",
    ]);
  } finally {
    store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("I5 empty/corrupt owner and ambiguous old-boot legacy token are diagnosed and preserved", () => {
  for (const content of [
    "",
    "{",
    JSON.stringify({ pid: 1 }),
    JSON.stringify({ ...current, machine: undefined, boot: "previous" }),
  ]) {
    const root = mkdtempSync(join(tmpdir(), "service-lock-corrupt-"));
    const lock = join(root, "coordinator.lock"),
      token = "owner-00000000-0000-0000-0000-000000000000.json";
    mkdirSync(lock);
    writeFileSync(join(lock, token), content);
    try {
      const store = new BackgroundServiceStore(root, undefined, identities);
      expect(() => store.acquire()).toThrow(
        content.includes("previous")
          ? "SERVICE_COORDINATOR_LEGACY_LOCALITY_UNCONFIRMED"
          : "SERVICE_COORDINATOR_LOCK_CORRUPT",
      );
      expect(readFileSync(join(lock, token), "utf8")).toBe(content);
      expect(readdirSync(lock)).toEqual([token]);
      expect(store.available()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("I5 only a proven local old-boot owner can be replaced on the real lock path", () => {
  for (const machine of [local.machine, "foreign-machine"]) {
    const root = mkdtempSync(join(tmpdir(), "service-lock-reboot-"));
    const lock = join(root, "coordinator.lock"),
      token = "owner-00000000-0000-0000-0000-000000000000.json";
    mkdirSync(lock);
    writeFileSync(join(lock, token), JSON.stringify({ ...current, machine, boot: "older" }));
    const store = new BackgroundServiceStore(root, undefined, identities);
    try {
      if (machine === local.machine) {
        store.acquire();
        expect(readdirSync(lock)).not.toContain(token);
        expect(store.available()).toBe(true);
      } else {
        expect(() => store.acquire()).toThrow("SERVICE_COORDINATOR_BUSY");
        expect(readdirSync(lock)).toEqual([token]);
      }
    } finally {
      store.release();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function stat(pid: number, group: number, state: string) {
  const fields = Array.from({ length: 22 }, () => "0");
  fields[0] = state;
  fields[2] = String(group);
  fields[19] = "123";
  return `${pid} (a name with ) parentheses) ${fields.join(" ")}`;
}
test("Linux group death counts terminal zombies, but never hides a live member or restricted /proc", () => {
  const files = new Map([
    ["/proc/100/stat", stat(100, 100, "Z")],
    ["/proc/101/stat", stat(101, 100, "Z")],
    ["/proc/self/stat", stat(process.pid, 999, "R")],
    ["/proc/mounts", "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n"],
  ]);
  const read = (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw Object.assign(Error("gone"), { code: "ENOENT" });
    return value;
  };
  expect(parseLinuxProcessStat(files.get("/proc/100/stat")!)?.state).toBe("Z");
  expect(linuxGroupStatus(100, read, () => ["100", "101"])).toBe("dead");
  files.set("/proc/101/stat", stat(101, 100, "S"));
  expect(linuxGroupStatus(100, read, () => ["100", "101"])).toBe("alive");
  files.set("/proc/mounts", "proc /proc proc rw,hidepid=2 0 0\n");
  expect(linuxGroupStatus(100, read, () => ["100"])).toBe("unknown");
});

test("Linux terminal confirmation sees a child forked between membership enumeration and stat", () => {
  let scans = 0;
  const read = (path: string) => {
    if (path === "/proc/mounts") return "proc /proc proc rw,nosuid,nodev,noexec 0 0\n";
    if (path === "/proc/self/stat") return stat(process.pid, 999, "R");
    if (path === "/proc/100/stat") return stat(100, 100, "Z");
    if (path === "/proc/101/stat") return stat(101, 100, "Z");
    if (path === "/proc/102/stat") return stat(102, 100, "S");
    throw Error(`unexpected read ${path}`);
  };
  // 101 forks 102 immediately after the first listing, then becomes terminal
  // before its stat is read. A one-pass scan incorrectly reported death.
  expect(
    linuxGroupStatus(100, read, () => (++scans === 1 ? ["100", "101"] : ["100", "101", "102"])),
  ).toBe("alive");
  expect(scans).toBe(2);
  scans = 0;
  expect(linuxGroupStatus(100, read, () => (++scans === 1 ? ["100", "101"] : ["100"]))).toBe(
    "unknown",
  );
  expect(scans).toBe(2);
});

test("reacquiring retained lock ownership cannot clear an uncertain record commit", () => {
  const root = mkdtempSync(join(tmpdir(), "service-record-poison-"));
  const store = new BackgroundServiceStore(
    root,
    (point) => {
      if (point === "rename") throw Error("record rename uncertainty");
    },
    identities,
  );
  try {
    store.acquire();
    const key = store.key({ appId: "test", projectPath: "/owned", name: "market" });
    expect(() => store.commit(key, { format: "panel.background-service/1" })).toThrow(
      "record rename uncertainty",
    );
    expect(store.available()).toBe(false);
    store.acquire();
    expect(store.available()).toBe(false);
    expect(() => store.commit(key, { format: "panel.background-service/1" })).toThrow(
      "SERVICE_COORDINATOR_UNAVAILABLE",
    );
  } finally {
    store.release();
    rmSync(root, { recursive: true, force: true });
  }
});
