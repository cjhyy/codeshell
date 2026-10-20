import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import children from "node:child_process";
import type { ToolContext } from "../tool-system/context.js";

// Only real owned RingFile bytes and production read leaves are exercised.
// Process state and the private registry are inert fixtures; no process exists.
const attempts: string[] = [];
const restore: Array<() => void> = [];
function deny(kind: string): never {
  attempts.push(kind);
  throw new Error(`Owned UTF8 frontier fixture denied ${kind}`);
}
function replace(object: any, key: string, value: unknown): void {
  const previous = object[key];
  object[key] = value;
  restore.push(() => (object[key] = previous));
}
replace(globalThis, "fetch", () => deny("fetch"));
for (const [object, keys, kind] of [
  [http, ["get", "request"], "http"],
  [https, ["get", "request"], "https"],
  [net, ["connect", "createConnection"], "socket"],
  [tls, ["connect"], "tls"],
  [
    children,
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
    "process",
  ],
  [Bun, ["spawn", "spawnSync"], "bun-process"],
  [process, ["kill"], "signal"],
] as const)
  for (const key of keys) replace(object, key, () => deny(kind));
syncBuiltinESMExports();
for (const probe of [
  () => fetch("https://example.invalid/denied"),
  () => http.request("http://127.0.0.1:9/denied"),
  () => https.get("https://example.invalid/denied"),
  () => net.connect(9, "127.0.0.1"),
  () => tls.connect(443, "example.invalid"),
  () => children.spawn("owned-denied-executable", []),
  () => Bun.spawn(["owned-denied-executable"]),
  () => process.kill(0, 0),
]) {
  let refused = false;
  try {
    probe();
  } catch (error) {
    refused =
      error instanceof Error && error.message.startsWith("Owned UTF8 frontier fixture denied ");
  }
  if (!refused) throw new Error("UTF8 frontier guard probe escaped");
}
const guardProbes = attempts.length;
attempts.length = 0;
const { RingFile } = await import("./ring-file.js");
const { BackgroundShellManager } = await import("./background-shell.js");
const { bashOutputTool } = await import("../tool-system/builtin/background-shell-tools.js");
const fixtures: Array<{ root: string; ring: InstanceType<typeof RingFile> }> = [];
afterEach(() => {
  try {
    expect(attempts).toEqual([]);
  } finally {
    for (const { root, ring } of fixtures.splice(0)) {
      ring.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
afterAll(() => {
  console.log(
    "OWNED_UTF8_FRONTIER_GUARD " + JSON.stringify({ guardProbes, actualAttempts: attempts }),
  );
  for (const undo of restore.reverse()) undo();
  syncBuiltinESMExports();
});

function fixture() {
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.CODE_SHELL_TEST_HOME).toBe(join(process.env.HOME!, ".code-shell"));
  expect(guardProbes).toBe(8);
  const root = realpathSync(mkdtempSync(join(process.env.HOME!, "owned-utf8-frontier-")));
  const path = join(root, "output.log");
  const ring = new RingFile(path, 8 * 1024 * 1024);
  fixtures.push({ root, ring });
  expect(ring.diskAvailable()).toBe(true);
  const record = {
    shellId: "owned-utf8",
    sessionId: "owned-session",
    status: "running",
    agentReadOffset: 0,
    didWrap: false,
    diskAvailable: true,
    ring,
  };
  // This map is solely this test's mocked registry. We never use the singleton,
  // spawnBackground(), orphan recovery, kill(), notification or real task state.
  const manager = new BackgroundShellManager();
  Object.defineProperty(manager, "shells", { value: new Map([[record.shellId, record]]) });
  const ctx = new Proxy({} as ToolContext, {
    get(_target, key) {
      if (key === "backgroundShells") return manager;
      if (key === "sessionId") return record.sessionId;
      throw new Error(`Unexpected tool context read: ${String(key)}`);
    },
  });
  const write = (bytes: Buffer) => {
    ring.write(bytes);
    expect(ring.didWrap()).toBe(false);
    expect(readFileSync(path)).toEqual(ring.sliceFromAbsolute(0));
  };
  const peek = async (mode?: "all") => {
    // Omit mode for incremental reads to exercise BashOutput's actual default.
    const result = await bashOutputTool(
      { shell_id: record.shellId, ...(mode ? { mode } : {}) },
      ctx,
    );
    expect(result.startsWith(`[owned-utf8 status=${record.status}`)).toBe(true);
    const body = result.slice(result.indexOf("\n") + 1);
    return body === "(no new output)" ? "" : body;
  };
  return { path, ring, manager, record, write, peek };
}

for (const [name, char, split] of [
  ["CJK after lead", "中", 1],
  ["CJK after first continuation", "中", 2],
  ["emoji after lead", "😀", 1],
  ["emoji after first continuation", "😀", 2],
  ["emoji after second continuation", "😀", 3],
] as const) {
  test(`a still-running incremental peek preserves ${name} across two actual file writes`, async () => {
    const { path, ring, record, write, peek } = fixture();
    const bytes = Buffer.from(`A${char}Z`, "utf8");
    const chunks = [bytes.subarray(0, 1 + split), bytes.subarray(1 + split)];
    write(chunks[0]);
    const first = await peek();
    const firstOffset = record.agentReadOffset;
    write(chunks[1]);
    const second = await peek();
    const secondOffset = record.agentReadOffset;
    const full = await peek("all");
    expect(record.agentReadOffset).toBe(secondOffset);
    expect(readFileSync(path)).toEqual(bytes);
    expect(ring.totalWritten()).toBe(bytes.length);
    expect(full).toBe(`A${char}Z`);
    expect(await peek()).toBe("");
    console.log(
      "OWNED_UTF8_FRONTIER_WITNESS " +
        JSON.stringify({
          name,
          chunksHex: chunks.map((chunk) => chunk.toString("hex")),
          first,
          second,
          firstOffset,
          secondOffset,
          full,
          diskHex: readFileSync(path).toString("hex"),
          totalBytes: ring.totalWritten(),
          processState: "mocked running; no process/real registry",
          expected: `A${char}Z`,
        }),
    );
    expect(first + second).toBe(`A${char}Z`);
  });
}

test("ASCII split writes keep disjoint incremental byte cursors", async () => {
  const { write, peek, record } = fixture();
  write(Buffer.from("one"));
  expect(await peek()).toBe("one");
  expect(record.agentReadOffset).toBe(3);
  write(Buffer.from("two"));
  expect(await peek()).toBe("two");
  expect(record.agentReadOffset).toBe(6);
  expect(await peek()).toBe("");
  expect(await peek("all")).toBe("onetwo");
});

test("complete CJK and emoji chunks keep their original characters", async () => {
  const { write, peek } = fixture();
  write(Buffer.from("A中"));
  const first = await peek();
  write(Buffer.from("😀Z"));
  expect(first + (await peek())).toBe("A中😀Z");
});

test("split UTF8 file writes without an intervening peek decode the complete retained bytes", async () => {
  const { write, peek } = fixture();
  const bytes = Buffer.from("A中😀Z");
  write(bytes.subarray(0, 2));
  write(bytes.subarray(2));
  expect(await peek()).toBe("A中😀Z");
});

test("complete valid bursts above the actual 16KiB cap retain the existing safe-cut pagination", async () => {
  const { write, peek, record } = fixture();
  const text = "a".repeat(16 * 1024 - 1) + "中Z";
  write(Buffer.from(text));
  const first = await peek();
  expect(record.agentReadOffset).toBe(16 * 1024 - 1);
  const second = await peek();
  expect(first + second).toBe(text);
  expect(await peek()).toBe("");
});

test("the actual session-ownership gate refuses another session without advancing the cursor", async () => {
  const { manager, record, write, peek } = fixture();
  write(Buffer.from("owned中"));
  const wrongSession = { sessionId: "foreign-session", backgroundShells: manager } as ToolContext;
  const result = await bashOutputTool({ shell_id: record.shellId }, wrongSession);
  expect(result).toBe("Error: Unknown shell_id: owned-utf8");
  expect(record.agentReadOffset).toBe(0);
  expect(await peek()).toBe("owned中");
});

test("repeated empty frontier peeks retain bytes until the missing continuation arrives", async () => {
  const { write, peek, record } = fixture();
  write(Buffer.from([0x41, 0xe4, 0xb8]));
  expect(await peek()).toBe("A");
  expect(record.agentReadOffset).toBe(1);
  expect(await peek()).toBe("");
  expect(record.agentReadOffset).toBe(1);
  expect(await peek("all")).toBe("A�"); // snapshot semantics stay unchanged
  expect(record.agentReadOffset).toBe(1);
  write(Buffer.from([0xad, 0x5a]));
  expect(await peek()).toBe("中Z");
  expect(record.agentReadOffset).toBe(5);
  expect(await peek()).toBe("");
});

for (const status of ["exited", "killed", "orphaned"] as const) {
  test(`${status} consumes an incomplete EOF once instead of retaining it forever`, async () => {
    const { write, peek, record } = fixture();
    write(Buffer.from([0x41, 0xf0, 0x9f, 0x98]));
    expect(await peek()).toBe("A");
    expect(record.agentReadOffset).toBe(1);
    record.status = status; // inert process state; no real process or lifecycle call
    expect(await peek()).toBe("�");
    expect(record.agentReadOffset).toBe(4);
    expect(await peek()).toBe("");
    expect(record.agentReadOffset).toBe(4);
  });
}

test("an already-terminal incomplete snapshot makes forward progress on its first read", async () => {
  const { write, peek, record } = fixture();
  write(Buffer.from([0xe4, 0xb8]));
  record.status = "exited";
  expect(await peek()).toBe("�");
  expect(record.agentReadOffset).toBe(2);
  expect(await peek()).toBe("");
});

test("invalid UTF8 bytes and impossible prefix ranges are consumed while still running", async () => {
  for (const raw of [
    [0x80],
    [0xc0],
    [0xc1],
    [0xf5],
    [0xff],
    [0xe0, 0x80],
    [0xed, 0xa0],
    [0xf0, 0x80],
    [0xf4, 0x90],
  ]) {
    const { write, peek, record } = fixture();
    const bytes = Buffer.from(raw);
    write(bytes);
    expect(await peek()).toBe(bytes.toString("utf8"));
    expect(record.agentReadOffset).toBe(bytes.length);
    expect(await peek()).toBe("");
  }
});

test("a held valid lead followed by an invalid next byte resumes with replacement decoding", async () => {
  const { write, peek, record } = fixture();
  write(Buffer.from([0xe4]));
  expect(await peek()).toBe("");
  expect(record.agentReadOffset).toBe(0);
  write(Buffer.from("X"));
  expect(await peek()).toBe("�X");
  expect(record.agentReadOffset).toBe(2);
  expect(await peek()).toBe("");
});

test("a partial frontier beyond a full cap stays unread until its remaining bytes arrive", async () => {
  const { write, peek, record } = fixture();
  const prefix = "a".repeat(16 * 1024);
  write(Buffer.concat([Buffer.from(prefix), Buffer.from([0xe4])]));
  expect(await peek()).toBe(prefix);
  expect(record.agentReadOffset).toBe(16 * 1024);
  expect(await peek()).toBe("");
  expect(record.agentReadOffset).toBe(16 * 1024);
  write(Buffer.from([0xb8, 0xad]));
  expect(await peek()).toBe("中");
  expect(record.agentReadOffset).toBe(16 * 1024 + 3);
  expect(await peek()).toBe("");
});

test("valid UTF8 range boundaries survive every unfinished split without buffering valid complete bytes", async () => {
  for (const codePoint of [0x80, 0x7ff, 0x800, 0xd7ff, 0xffff, 0x10000, 0x10ffff]) {
    const char = String.fromCodePoint(codePoint);
    const bytes = Buffer.from(char);
    for (let split = 1; split < bytes.length; split++) {
      const { write, peek, record } = fixture();
      write(Buffer.concat([Buffer.from("A"), bytes.subarray(0, split)]));
      expect(await peek()).toBe("A");
      expect(record.agentReadOffset).toBe(1);
      write(Buffer.concat([bytes.subarray(split), Buffer.from("Z")]));
      expect(await peek()).toBe(char + "Z");
      expect(record.agentReadOffset).toBe(bytes.length + 2);
      expect(await peek()).toBe("");
    }
  }
});

test("a starting stream retains its incomplete frontier until it becomes complete", async () => {
  const { write, peek, record } = fixture();
  record.status = "starting";
  write(Buffer.from([0xc2]));
  expect(await peek()).toBe("");
  expect(record.agentReadOffset).toBe(0);
  record.status = "running";
  write(Buffer.from([0x80]));
  expect(await peek()).toBe("\u0080");
  expect(record.agentReadOffset).toBe(2);
});
