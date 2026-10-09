import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationDirectory, operationFile, readOperationFile } from "./files.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "operation-files-"));
  roots.push(root);
  const directory = join(root, "private");
  operationDirectory(directory, true);
  const file = join(directory, "receipt.json");
  writeFileSync(file, '{"state":"unknown"}', { mode: 0o600 });
  return { root, directory, file };
}

test("requested private sidecars round-trip on the actual host filesystem", () => {
  const { directory, file } = fixture();
  expect(operationDirectory(directory).isDirectory()).toBe(true);
  expect(operationFile(file, 64).nlink).toBe(1);
  expect(readOperationFile(file, 64)).toBe('{"state":"unknown"}');
  if (process.platform !== "win32") {
    expect(operationDirectory(directory).mode & 0o777).toBe(0o700);
    expect(operationFile(file, 64).mode & 0o777).toBe(0o600);
  }
});

test("POSIX rejects group or other access while Windows mode is not an ACL proof", () => {
  const { directory, file } = fixture();
  // On Windows chmod does not implement owner/group/other distinctions. This
  // branch runs against real win32 in CI, rather than redefining platform.
  chmodSync(file, 0o666);
  chmodSync(directory, 0o777);
  if (process.platform === "win32") {
    expect(operationDirectory(directory).isDirectory()).toBe(true);
    expect(readOperationFile(file, 64)).toBe('{"state":"unknown"}');
  } else {
    expect(() => operationDirectory(directory)).toThrow("directory");
    expect(() => operationFile(file, 64)).toThrow("private operation file");
    expect(() => readOperationFile(file, 64)).toThrow("private operation file");
  }
});

test("directory links and file links cannot redirect bounded operation reads", () => {
  const { root, directory, file } = fixture();
  const outside = join(root, "outside");
  mkdirSync(outside, { mode: 0o700 });
  const evidence = join(outside, "evidence.json");
  writeFileSync(evidence, "preserve original", { mode: 0o600 });
  const directoryLink = join(root, "directory-link");
  symlinkSync(outside, directoryLink, process.platform === "win32" ? "junction" : "dir");
  expect(() => operationDirectory(directoryLink)).toThrow("directory");
  const fileLink = join(directory, "file-link.json");
  // A Windows junction also exercises a real non-regular linked file path
  // without relying on privileged file symlink creation on the CI host.
  symlinkSync(
    process.platform === "win32" ? outside : evidence,
    fileLink,
    process.platform === "win32" ? "junction" : "file",
  );
  expect(() => operationFile(fileLink, 64)).toThrow();
  expect(() => readOperationFile(fileLink, 64)).toThrow();
  expect(() => operationFile(directory, 64)).toThrow();
  expect(() => operationDirectory(file)).toThrow();
  expect(readFileSync(evidence, "utf8")).toBe("preserve original");
});

test("hard links, oversized data and invalid UTF-8 remain rejected on every platform", () => {
  const { directory, file } = fixture();
  const linked = join(directory, "hard-link.json");
  linkSync(file, linked);
  expect(() => operationFile(file, 64)).toThrow();
  expect(() => readOperationFile(linked, 64)).toThrow();
  rmSync(linked);
  writeFileSync(file, "x".repeat(65));
  expect(() => operationFile(file, 64)).toThrow("bounds");
  expect(() => readOperationFile(file, 64)).toThrow("bounds");
  writeFileSync(file, Buffer.from([0xc3, 0x28]));
  expect(() => readOperationFile(file, 64)).toThrow();
  expect(() => readOperationFile(join(directory, "missing.json"), 64)).toThrow();
});

test("POSIX private modes do not misinterpret Windows synthesized modes as ACLs", () => {
  const root = mkdtempSync(join(tmpdir(), "operation-file-platform-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const actualPlatform = process.platform;
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
    // Controller/review and the actual filesystem cases above in its real CI shard.
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(operationDirectory(directory).isDirectory()).toBe(true);
    expect(readOperationFile(file, 16)).toBe("fixture");
    const symbolic = join(directory, "symlink");
    const target = actualPlatform === "win32" ? join(root, "junction-target") : file;
    if (actualPlatform === "win32") mkdirSync(target);
    symlinkSync(target, symbolic, actualPlatform === "win32" ? "junction" : "file");
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
