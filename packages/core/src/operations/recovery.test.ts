import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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
});
