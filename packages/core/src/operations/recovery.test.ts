import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  linkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { OperationRecoveryFiles } from "./recovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "operation-recovery-"));
  roots.push(root);
  return {
    root,
    files: new OperationRecoveryFiles(root),
    key: randomBytes(32),
    id: "a".repeat(64),
  };
}

describe("private immutable operation recovery inputs", () => {
  test("cold reopen decrypts exact input without exposing a request body on disk", () => {
    const { root, files, key, id } = fixture();
    const input = JSON.stringify({ plan: { parameters: { body: "private-request-body" } } });
    const digest = files.save(key, id, input);
    const file = join(root, "recovery", id, `${digest}.json`);
    expect(readFileSync(file, "utf8")).not.toContain("private-request-body");
    expect(new OperationRecoveryFiles(root).read(key, id, digest)).toBe(input);
    expect(files.save(key, id, input)).toBe(digest);
    expect(readdirSync(join(root, "recovery", id))).toEqual([`${digest}.json`]);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "recovery", id)).mode & 0o777).toBe(0o700);
    }
  });

  test("wrong root key, operation identity, digest or ciphertext cannot authenticate", () => {
    const { root, files, key, id } = fixture();
    const digest = files.save(key, id, '{"identity":42}');
    expect(() => files.read(randomBytes(32), id, digest)).toThrow();
    const other = "b".repeat(64);
    const directory = join(root, "recovery", other);
    mkdirSync(directory);
    const original = readFileSync(join(root, "recovery", id, `${digest}.json`), "utf8");
    writeFileSync(join(directory, `${digest}.json`), original);
    expect(() => files.read(key, other, digest)).toThrow();
    const file = join(root, "recovery", id, `${digest}.json`);
    const envelope = JSON.parse(original);
    envelope.ciphertext = Buffer.from("tampered").toString("base64");
    writeFileSync(file, JSON.stringify(envelope));
    expect(() => files.read(key, id, digest)).toThrow();
    expect(() => files.save(key, id, '{"identity":42}')).toThrow();
  });

  test("only two original evidence versions fit; oversized and unsafe paths fail closed", () => {
    const { root, files, key, id } = fixture();
    files.save(key, id, '{"phase":"prepared"}');
    files.save(key, id, '{"phase":"identity"}');
    expect(() => files.save(key, id, '{"phase":"replacement"}')).toThrow("slots are full");
    expect(() => files.save(key, "../escape", "{}")).toThrow("identity");
    expect(() => files.save(key, "c".repeat(64), "x".repeat(512 * 1024 + 1))).toThrow("bounds");
    expect(readdirSync(join(root, "recovery", id))).toHaveLength(2);
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "recovery", "d".repeat(64)), "dir");
    expect(() => files.save(key, "d".repeat(64), "{}")).toThrow("directory");
    expect(readdirSync(outside)).toHaveLength(0);
  });

  test("bounded reads reject symlinks, oversized files and missing inputs without creating paths", () => {
    const { root, files, key, id } = fixture();
    expect(() => files.read(key, id, "b".repeat(64))).toThrow();
    expect(readdirSync(root)).toHaveLength(0);
    const digest = files.save(key, id, "{}");
    const file = join(root, "recovery", id, `${digest}.json`);
    writeFileSync(file, "x".repeat(704 * 1024 + 1));
    expect(() => files.read(key, id, digest)).toThrow("bounds");
    rmSync(file);
    const outside = join(root, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, file, "file");
    expect(() => files.read(key, id, digest)).toThrow();
  });

  test("only real writes collect interrupted atomic staging, preserving every completed slot", () => {
    const { root, files, key, id } = fixture();
    const prepared = files.save(key, id, '{"phase":"prepared"}');
    const directory = join(root, "recovery", id);
    const stage = join(directory, `${"b".repeat(64)}.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(stage, "interrupted encrypted envelope", { mode: 0o600 });
    expect(files.read(key, id, prepared)).toBe('{"phase":"prepared"}');
    expect(() => files.inspect(key, id, [prepared])).toThrow();
    expect(existsSync(stage)).toBe(true);
    const identity = files.save(key, id, '{"phase":"identity"}');
    expect(existsSync(stage)).toBe(false);
    expect(files.inspect(key, id, [prepared, identity]).slots).toHaveLength(2);
    expect(files.read(key, id, identity)).toBe('{"phase":"identity"}');
    expect(() => files.save(key, id, '{"phase":"replacement"}')).toThrow("slots are full");
  });

  test("unknown, linked and oversized recovery entries are preserved and reject cleanup", () => {
    for (const kind of ["unknown", "symlink", "hardlink", "oversized"] as const) {
      const { root, files, key, id } = fixture();
      const prepared = files.save(key, id, "{}");
      const directory = join(root, "recovery", id);
      const known = join(directory, `${"b".repeat(64)}.json.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(known, "known staging", { mode: 0o600 });
      const unsafe = join(
        directory,
        kind === "unknown"
          ? "unrecognized.tmp"
          : `${"c".repeat(64)}.json.${process.pid}.${randomUUID()}.tmp`,
      );
      const outside = join(root, "outside.json");
      writeFileSync(outside, "preserve outside", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(outside, unsafe);
      else if (kind === "hardlink") linkSync(outside, unsafe);
      else
        writeFileSync(unsafe, kind === "oversized" ? "x".repeat(704 * 1024 + 1) : "unknown", {
          mode: 0o600,
        });
      expect(() => files.collect(id)).toThrow();
      expect(() => files.save(key, id, '{"identity":42}')).toThrow();
      expect(existsSync(known)).toBe(true);
      expect(existsSync(unsafe)).toBe(true);
      expect(files.read(key, id, prepared)).toBe("{}");
      expect(readFileSync(outside, "utf8")).toBe("preserve outside");
    }
  });
});
