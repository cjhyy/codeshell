import { expect, test } from "bun:test";
import { bundleInSubprocess } from "../../../../tests/helpers/bundle-in-subprocess.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
  spawnServiceProcess,
  readServiceCustody,
  waitForServiceGroupExit,
  type ServiceProcess,
} from "./background-service-process.js";
import {
  darwinProcessStart,
  createBootSessionReader,
  identityStatus,
  processIdentity,
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
async function runNativeCustodyFixture(scenario: "guardian-loss" | "custody-fd") {
  const root = await realpath(await mkdtemp(join(tmpdir(), `service-${scenario}-`)));
  let passed = false;
  try {
    bundleInSubprocess(
      [join(import.meta.dir, "__fixtures__/background-service-custody.ts")],
      root,
      { naming: "custody.mjs" },
    );
    const executable = (await resolvePanelExecutable("node"))!;
    const result = await promisify(execFile)(
      executable,
      ["--unhandled-rejections=strict", join(root, "custody.mjs"), scenario, root],
      { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
    );
    const receipt = JSON.parse(result.stdout.trim());
    expect(receipt).toMatchObject({ scenario, memberDead: true });
    passed = true;
  } catch (error) {
    // Preserve failed owned-process evidence; a failed assertion is not proof
    // every descendant has exited and must not remove their fixture directory.
    throw new Error(`Native custody fixture retained at ${root}`, { cause: error });
  } finally {
    if (passed) await rm(root, { recursive: true, force: true });
  }
}

test("guardian kill cannot orphan a native member that ignores EOF", async () => {
  await runNativeCustodyFixture("guardian-loss");
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
  await runNativeCustodyFixture("custody-fd");
});

test("custody IO failure retains the actual syscall and closes both bounded promises", async () => {
  const stream = new PassThrough();
  let inspected = 0;
  const reader = readServiceCustody(stream, 10, {
    current() {
      inspected++;
      return null;
    },
    status: () => "unknown",
  });
  stream.write(Buffer.alloc(8192, 32));
  const cause = Object.assign(new Error("bad descriptor"), { code: "EBADF", syscall: "read" });
  stream.destroy(cause);
  await expect(reader.custody).rejects.toThrow("SERVICE_CUSTODY_IO:EBADF:read");
  await expect(reader.member).rejects.toThrow("SERVICE_CUSTODY_IO:EBADF:read");
  await reader.member.catch((error) => expect(error.cause).toBe(cause));
  expect(inspected).toBe(0);
  expect(reader.retainedBytes).toBe(0);
  expect(stream.destroyed).toBe(true);
});

test("member custody IO failure preserves the guardian receipt without admitting a member", async () => {
  const stream = new PassThrough(),
    inspected: number[] = [];
  const reader = readServiceCustody(stream, 10, {
    current(pid) {
      inspected.push(pid);
      return { pid, start: "linux-ticks:1", host: "fixture", boot: "fixture" };
    },
    status: () => "alive",
  });
  stream.write(
    JSON.stringify({ t: "custody", pid: 10, nonce: "00000000-0000-0000-0000-000000000001" }) + "\n",
  );
  expect((await reader.custody).pid).toBe(10);
  stream.destroy(Object.assign(new Error("reset"), { code: "ECONNRESET", syscall: "read" }));
  await expect(reader.member).rejects.toThrow("SERVICE_CUSTODY_IO:ECONNRESET:read");
  expect((await reader.custody).pid).toBe(10);
  expect(reader.memberIdentity).toBeUndefined();
  expect(reader.retainedBytes).toBe(0);
  expect(inspected).toEqual([10]);
});

test("group death confirmation waits past guardian close and preserves the proven observation", async () => {
  let observed = 0,
    clock = 0,
    resume!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let settled = false;
  const confirmation = waitForServiceGroupExit(
    10,
    2000,
    () => {
      observed++;
      // A live member may still exist after the guardian's close event. Once
      // proven dead, a later unrelated /proc read error cannot undo that proof.
      return observed === 1 ? "alive" : observed === 2 ? "dead" : "unknown";
    },
    () => clock,
    async () => {
      await barrier;
      clock = 20;
    },
  ).then((confirmed) => {
    settled = true;
    return confirmed;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(observed).toBe(1);
  resume();
  expect(await confirmation).toBe(true);
  expect(observed).toBe(2);
});

test("group death confirmation never treats unknown as death and uses a bounded monotonic deadline", async () => {
  let clock = 0,
    observed = 0;
  const confirmed = await waitForServiceGroupExit(
    10,
    40,
    () => {
      observed++;
      return "unknown";
    },
    () => clock,
    async (delay) => {
      clock += delay;
    },
  );
  expect(confirmed).toBe(false);
  expect(clock).toBe(40);
  expect(observed).toBe(3);
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
