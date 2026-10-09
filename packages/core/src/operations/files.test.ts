import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationDirectory, operationFile, readOperationFile } from "./files.js";

test("POSIX private modes do not misinterpret Windows synthesized modes as ACLs", () => {
  const root = mkdtempSync(join(tmpdir(), "operation-file-platform-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    const directory = join(root, "archive");
    const file = join(directory, "receipt");
    mkdirSync(directory);
    writeFileSync(file, "fixture");
    chmodSync(directory, 0o755);
    chmodSync(file, 0o644);
    if (process.platform !== "win32") {
      expect(() => operationDirectory(directory)).toThrow("private operation directory");
      expect(() => operationFile(file, 16)).toThrow("private operation file");
    }
    // Unit coverage of the platform policy; real Windows runs the unchanged
    // Controller/review consumer cases in its actual CI shard.
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(operationDirectory(directory).isDirectory()).toBe(true);
    expect(readOperationFile(file, 16)).toBe("fixture");
    const symbolic = join(directory, "symlink");
    symlinkSync(file, symbolic);
    expect(() => readOperationFile(symbolic, 16)).toThrow("private operation file");
    const alias = join(directory, "hardlink");
    linkSync(file, alias);
    expect(() => readOperationFile(file, 16)).toThrow("private operation file");
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows mode policy retains bounded regular file and fatal UTF8 checks", () => {
  const root = mkdtempSync(join(tmpdir(), "operation-file-bounds-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const file = join(root, "receipt");
    writeFileSync(file, "longer than the limit");
    expect(() => readOperationFile(file, 4)).toThrow("bounds");
    writeFileSync(file, Buffer.from([0xc3, 0x28]));
    expect(() => readOperationFile(file, 4)).toThrow();
    expect(() => operationFile(root, 1024)).toThrow("private operation file");
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(root, { recursive: true, force: true });
  }
});
