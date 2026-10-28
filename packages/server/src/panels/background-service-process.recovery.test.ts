import { expect, test } from "bun:test";
import { bundleInSubprocess } from "../../../../tests/helpers/bundle-in-subprocess.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
  spawnServiceProcess,
  readServiceCustody,
  type ServiceProcess,
} from "./background-service-process.js";
import {
  darwinProcessStart,
  createBootSessionReader,
  identityStatus,
  processIdentity,
  groupStatus,
  type ServiceIdentityInspector,
} from "./background-service-store.js";
import { resolvePanelExecutable } from "./process-service.js";

// The boot UUID/probe policy boundaries are injected only for this owned-process
// fault test. Real libproc start identity, guardian IPC, permission flags, signals,
// process-group supervision and exit confirmation remain production code.
const identities: ServiceIdentityInspector = {
  current(pid) {
    if (process.platform !== "darwin") return processIdentity(pid);
    const start = darwinProcessStart(pid);
    return start ? { pid, start, boot: "owned-test-boot", host: hostname() } : null;
  },
  status(value) {
    return identityStatus(value, identities.current);
  },
};
test("guardian kill cannot orphan a native member that ignores EOF", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "service-guardian-loss-")));
  let actual: ServiceProcess | undefined;
  try {
    const cwd = join(root, "data"),
      entry = join(root, "entry.mjs");
    await mkdir(cwd);
    const source = `import{createInterface}from'node:readline';
setInterval(()=>{},1000);createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.t==='hello')console.log(JSON.stringify({t:'ready'}));if(m.t==='poke')process.kill(process.ppid,'SIGKILL')});`;
    await writeFile(entry, source);
    let ready!: () => void;
    const readySignal = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const exits: Array<string | undefined> = [];
    actual = await spawnServiceProcess(
      {
        executable: (await resolvePanelExecutable("node"))!,
        entry,
        packageRoot: root,
        cwd,
        sha256: createHash("sha256").update(source).digest("hex"),
        maxLineBytes: 4096,
        onLine(message: any) {
          if (message.t === "ready") ready();
        },
        onExit(error) {
          exits.push(error);
        },
      },
      { identities, probeRuntime: async () => ["--permission"] },
    );
    const member = await actual.prepare();
    expect(identities.status(member)).toBe("alive");
    actual.activate({ t: "hello" });
    await readySignal;
    actual.send({ t: "poke" });
    await actual.exited;
    expect(exits).toContain("SERVICE_CUSTODY_LEADER_EXITED");
    // Pipes closed and the previously observed executable identity is dead.
    // Linux may retain a zombie /proc entry until PID 1 reaps it; that terminal
    // state is not a live identity and must not require arbitrary sleeps.
    // Restricted hosts may return EPERM rather than ESRCH for a negative PGID;
    // production must preserve unconfirmed state in that case, never assert death.
    expect(identities.current(member.pid)).toBeNull();
    const status = groupStatus(actual.identity.pid);
    expect(status).not.toBe("alive");
    expect(await actual.terminate(0)).toBe(status === "dead");
  } finally {
    await actual?.terminate(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("I8 custody uses a strict total 8192-byte bound and releases listeners/buffer on limit", async () => {
  const stream = new PassThrough();
  let inspected = 0;
  const reader = readServiceCustody(stream, 10, {
    current: () => {
      inspected++;
      return null;
    },
    status: () => "unknown",
  });
  stream.write(Buffer.alloc(8192, 32));
  expect(reader.retainedBytes).toBe(8192);
  stream.write(Buffer.from("x"));
  await expect(reader.custody).rejects.toThrow("SERVICE_CUSTODY_LIMIT");
  await expect(reader.member).rejects.toThrow("SERVICE_CUSTODY_LIMIT");
  expect(stream.destroyed).toBe(true);
  expect(reader.retainedBytes).toBe(0);
  expect(stream.listenerCount("data")).toBe(0);
  stream.emit("data", Buffer.alloc(1024 * 1024));
  expect(inspected).toBe(0);
  expect(reader.retainedBytes).toBe(0);
});

test("I8 accepts only ordered custody/member, probes each identity once and closes after member", async () => {
  const stream = new PassThrough(),
    inspected: number[] = [];
  const reader = readServiceCustody(stream, 10, {
    current: (pid) => {
      inspected.push(pid);
      return { pid, start: "linux-ticks:1", host: "fixture", boot: "fixture" };
    },
    status: () => "alive",
  });
  const custody =
    JSON.stringify({ t: "custody", pid: 10, nonce: "00000000-0000-0000-0000-000000000001" }) + "\n";
  const member = JSON.stringify({ t: "member", pid: 11 }) + "\n";
  const padding = " ".repeat(8192 - Buffer.byteLength(custody + member));
  stream.write(Buffer.from(padding + custody + member));
  expect((await reader.custody).pid).toBe(10);
  expect((await reader.member).pid).toBe(11);
  expect(inspected).toEqual([10, 11]);
  expect(stream.destroyed).toBe(true);
  expect(reader.retainedBytes).toBe(0);
  stream.emit("data", Buffer.from(member.repeat(500)));
  expect(inspected).toEqual([10, 11]);

  const duplicate = new PassThrough(),
    ids: number[] = [];
  const rejected = readServiceCustody(duplicate, 10, {
    current: (pid) => {
      ids.push(pid);
      return { pid, start: "linux-ticks:1", host: "fixture", boot: "fixture" };
    },
    status: () => "alive",
  });
  duplicate.write(custody + custody);
  await expect(rejected.member).rejects.toThrow("SERVICE_CUSTODY_INVALID");
  expect(ids).toEqual([10]);
  expect(duplicate.destroyed).toBe(true);
  expect(rejected.retainedBytes).toBe(0);
});

test("I8 actual native member cannot inherit the guardian custody FD", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "service-custody-fd-")));
  let actual: ServiceProcess | undefined;
  try {
    const entry = join(root, "entry.mjs");
    const source = `import fs from'node:fs';process.stdin.once('data',()=>{try{fs.writeSync(3,JSON.stringify({t:'member',pid:process.pid})+'\\n');}catch{}console.log(JSON.stringify({t:'ready'}));process.exit(0)});`;
    await writeFile(entry, source);
    const messages: unknown[] = [],
      inspected: number[] = [];
    actual = await spawnServiceProcess(
      {
        executable: (await resolvePanelExecutable("node"))!,
        entry,
        packageRoot: root,
        cwd: root,
        sha256: createHash("sha256").update(source).digest("hex"),
        maxLineBytes: 4096,
        onLine: (message) => messages.push(message),
        onExit() {},
      },
      {
        identities: {
          current: (pid) => {
            inspected.push(pid);
            return identities.current(pid);
          },
          status: identities.status,
        },
      },
    );
    // Linux can reuse FD number 3 for Node's own epoll/pipe. Compare the actual
    // kernel object, not fstat's socket type or the mere presence of that number.
    const custodyFd =
      process.platform === "linux" ? await stat(`/proc/${actual.identity.pid}/fd/3`) : null;
    const member = await actual.prepare();
    if (custodyFd) {
      const memberFd = await stat(`/proc/${member.pid}/fd/3`).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      expect(memberFd && `${memberFd.dev}:${memberFd.ino}`).not.toBe(
        `${custodyFd.dev}:${custodyFd.ino}`,
      );
    }
    expect(inspected).toEqual([actual.identity.pid, member.pid]);
    actual.activate({ t: "hello" });
    await actual.exited;
    expect(messages).toEqual([{ t: "ready" }]);
    expect(inspected).toHaveLength(2);
  } finally {
    await actual?.terminate(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("spawn failure observes custody rejection before close", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "service-spawn-failure-")));
  try {
    const entry = join(root, "entry.mjs"),
      source = "export {};";
    await writeFile(entry, source);
    // Execute this failure under Node, matching Electron's child_process event
    // ordering. Bun throws invalid-cwd spawn failures before a child is returned.
    bundleInSubprocess([join(import.meta.dir, "background-service-process.ts")], root, {
      naming: "process.mjs",
    });
    const executable = (await resolvePanelExecutable("node"))!;
    const input = {
      executable,
      entry,
      packageRoot: root,
      cwd: join(root, "missing-directory"),
      sha256: createHash("sha256").update(source).digest("hex"),
      maxLineBytes: 4096,
    };
    const script = `
import { spawnServiceProcess } from ${JSON.stringify(join(root, "process.mjs"))};
let closed;const closeSignal=new Promise(resolve=>{closed=resolve});
try {
 await spawnServiceProcess({...${JSON.stringify(input)},onLine(){},onExit(){closed()}},{probeRuntime:async()=>["--permission"]});
 throw Error('EXPECTED_SPAWN_FAILURE');
} catch(error) { if(error.code!=='ENOENT')throw error; }
await closeSignal;
`;
    const result = await promisify(execFile)(executable, [
      "--unhandled-rejections=strict",
      "--input-type=module",
      "-e",
      script,
    ]);
    expect(result.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, source] of [
  [
    "plain data listener",
    `process.stdin.once('data',chunk=>{const hello=JSON.parse(chunk);console.log(JSON.stringify({t:'ready',echo:hello.marker}));process.exit(0)});`,
  ],
  [
    "top-level await data listener",
    `const chunk=await new Promise(resolve=>process.stdin.once('data',resolve));const hello=JSON.parse(chunk);console.log(JSON.stringify({t:'ready',echo:hello.marker}));process.exit(0);`,
  ],
  [
    "top-level await readline iterator",
    `import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const hello=JSON.parse(line);console.log(JSON.stringify({t:'ready',echo:hello.marker}));break;}process.exit(0);`,
  ],
]) {
  test(`held native bootstrap delivers hello to ${name}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "service-bootstrap-input-")));
    let actual: ServiceProcess | undefined;
    try {
      const entry = join(root, "entry.mjs");
      await writeFile(entry, source!);
      const messages: unknown[] = [];
      actual = await spawnServiceProcess(
        {
          executable: (await resolvePanelExecutable("node"))!,
          entry,
          packageRoot: root,
          cwd: root,
          sha256: createHash("sha256").update(source!).digest("hex"),
          maxLineBytes: 4096,
          onLine(message) {
            messages.push(message);
          },
          onExit() {},
        },
        { identities },
      );
      // The actual patched Node is probed and permission flags are not overridden.
      await actual.prepare();
      actual.activate({ t: "hello", marker: "buffered-exactly-once" });
      await actual.exited;
      expect(messages).toEqual([{ t: "ready", echo: "buffered-exactly-once" }]);
    } finally {
      await actual?.terminate(0);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("OS boot constant caches success but failed reads back off without asserting identity", () => {
  let clock = 0,
    calls = 0;
  const uuid = "01234567-89ab-cdef-0123-456789abcdef";
  const read = createBootSessionReader(
    () => {
      calls++;
      if (calls === 1) throw new Error("OS inspection unavailable");
      if (calls === 2) return "not-a-boot-uuid";
      return uuid;
    },
    () => clock,
  );
  expect(read()).toBeNull();
  expect(read()).toBeNull();
  expect(calls).toBe(1);
  clock = 1000;
  expect(read()).toBeNull();
  clock = 2000;
  expect(read()).toBe(uuid);
  clock = 3000;
  expect(read()).toBe(uuid);
  expect(calls).toBe(3);
});
