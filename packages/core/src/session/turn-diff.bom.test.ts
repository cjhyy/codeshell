import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import children from "node:child_process";

// Owned files and the real tracker only; no network origin or process is allowed.
// Install denial before importing the Core leaf, not merely an isolated HOME.
const attempts: string[] = [];
const restore: Array<() => void> = [];
function deny(kind: string): never {
  attempts.push(kind);
  throw Error(`Owned BOM tracker fixture denied ${kind}`);
}
function replace(object: any, key: string, value: unknown) {
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
]) {
  let refused = false;
  try {
    probe();
  } catch (error) {
    refused =
      error instanceof Error && error.message.startsWith("Owned BOM tracker fixture denied ");
  }
  if (!refused) throw Error("BOM tracker guard probe escaped");
}
const guardProbes = attempts.length;
attempts.length = 0;
const { TurnDiffTracker } = await import("./turn-diff.js");
const roots: string[] = [];
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8 = (text: string) => Buffer.from(text, "utf8");
const withBom = (text: string) => Buffer.concat([bom, utf8(text)]);
afterEach(() => {
  expect(attempts).toEqual([]);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  for (const undo of restore.reverse()) undo();
  syncBuiltinESMExports();
});

function captured(before: Buffer, after: Buffer) {
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.CODE_SHELL_TEST_HOME).toBe(join(process.env.HOME!, ".code-shell"));
  expect(guardProbes).toBe(6);
  const cwd = realpathSync.native(mkdtempSync(join(process.env.HOME!, "owned-turn-diff-bom-")));
  roots.push(cwd);
  const path = join(cwd, "bytes.txt");
  writeFileSync(path, before);
  const beforeHex = readFileSync(path).toString("hex");
  expect(beforeHex).toBe(before.toString("hex"));
  const tracker = new TurnDiffTracker({ cwd, turnId: "owned-bom-turn" });
  tracker.begin("owned-write", [path]);
  writeFileSync(path, after);
  expect(readFileSync(path)).toEqual(after);
  return {
    result: tracker.end("owned-write", true)!,
    path,
    beforeHex,
    afterHex: readFileSync(path).toString("hex"),
  };
}

/** Independent patch interpreter verifies raw UTF-8 bytes and every consumed line. */
function applyExact(before: Buffer, patch: string): Buffer {
  const input = before.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output: string[] = [];
  const rows = patch.split("\n");
  let cursor = 0;
  for (let i = 0; i < rows.length; i++) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(rows[i]);
    if (!header) continue;
    const start = Number(header[1]) - (Number(header[2]) ? 1 : 0);
    output.push(...input.slice(cursor, start));
    cursor = start;
    let removed = 0,
      added = 0;
    while (i + 1 < rows.length && !rows[i + 1].startsWith("@@ ")) {
      const row = rows[++i];
      if (!/^[ +-]/.test(row)) continue;
      let value = row.slice(1) + "\n";
      if (rows[i + 1] === "\\ No newline at end of file") {
        value = value.slice(0, -1);
        i++;
      }
      if (row[0] !== "+") {
        expect(input[cursor++]).toBe(value);
        removed++;
      }
      if (row[0] !== "-") {
        output.push(value);
        added++;
      }
    }
    expect(removed).toBe(Number(header[2]));
    expect(added).toBe(Number(header[4]));
    i--;
  }
  output.push(...input.slice(cursor));
  return Buffer.from(output.join(""), "utf8");
}

for (const [name, before, after] of [
  ["BOM removal", withBom("A\n"), utf8("A\n")],
  ["BOM addition", utf8("A\n"), withBom("A\n")],
  ["content change with a BOM on both sides", withBom("A\n"), withBom("B\n")],
  ["BOM removal without a final newline", withBom("A"), utf8("A")],
  ["BOM addition with CRLF", utf8("A\r\nB\r\n"), withBom("A\r\nB\r\n")],
] as const) {
  test(`preserves exact owned bytes for ${name}`, () => {
    const { result, path, beforeHex, afterHex } = captured(before, after);
    console.log(
      "OWNED_BOM_WITNESS " +
        JSON.stringify({
          name,
          beforeHex,
          afterHex,
          complete: result.complete,
          files: result.files,
        }),
    );
    expect(result.complete).toBe(true);
    expect(result.omissions).toEqual([]);
    expect(result.trackedPaths).toEqual([path]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path, status: "modified", added: 1, removed: 1 });
    expect(applyExact(before, result.files[0].diff)).toEqual(after);
  });
}

test("unchanged leading BOM is retained as an authoritative empty diff", () => {
  const content = withBom("A\n");
  const { result, path } = captured(content, content);
  expect(result.complete).toBe(true);
  expect(result.files).toEqual([]);
  expect(result.trackedPaths).toEqual([path]);
  expect(result.toolCallIds).toEqual(["owned-write"]);
});

test("fatal UTF-8 validation still rejects invalid before or after bytes, including after a BOM", () => {
  for (const [before, after] of [
    [Buffer.from([0xc3, 0x28]), utf8("A\n")],
    [utf8("A\n"), Buffer.concat([bom, Buffer.from([0xc3, 0x28])])],
    [Buffer.from([0xef, 0xbb]), utf8("A\n")],
  ]) {
    const { result, path } = captured(before, after);
    expect(result.complete).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.trackedPaths).toEqual([path]);
    expect(result.omissions).toEqual([{ path, reason: "non-UTF-8 file" }]);
  }
});
