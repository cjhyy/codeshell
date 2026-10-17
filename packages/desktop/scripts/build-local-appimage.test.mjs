import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appImageBuildArguments,
  assertType2AppImageHeader,
  hashAppImage,
} from "./build-local-appimage.mjs";

function header() {
  const b = Buffer.alloc(32);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(b);
  Buffer.from([0x41, 0x49, 2]).copy(b, 8);
  b.writeUInt16LE(62, 18);
  return b;
}
test("AppImage conversion is native Linux x64, uses prepackaged source and never publishes", () => {
  assert.deepEqual(appImageBuildArguments("/owned/source", "linux", "x64"), [
    "--linux",
    "AppImage",
    "--x64",
    "--prepackaged",
    "/owned/source",
    "--publish",
    "never",
  ]);
  for (const platform of ["darwin", "win32"])
    assert.throws(() => appImageBuildArguments("/owned/source", platform, "x64"), /native Linux/);
  assert.throws(() => appImageBuildArguments("/owned/source", "linux", "arm64"), /x64/);
  assert.throws(() => appImageBuildArguments("relative", "linux", "x64"), /absolute/);
});
test("only Linux x64 ELF type-2 AppImage headers are accepted", () => {
  assertType2AppImageHeader(header());
  for (const [offset, value] of [
    [0, 0],
    [4, 1],
    [5, 2],
    [8, 0],
    [10, 1],
    [18, 0],
  ]) {
    const b = header();
    b[offset] = value;
    assert.throws(() => assertType2AppImageHeader(b), /type-2/);
  }
  assert.throws(() => assertType2AppImageHeader(Buffer.alloc(19)), /type-2/);
});
test("image checksum binds actual owned bytes and rejects links or unrelated binaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "appimage-header-fixture-"));
  try {
    const file = join(directory, "owned.AppImage");
    await writeFile(file, header());
    const before = await hashAppImage(file);
    assert.equal(before.size, 32);
    assert.match(before.sha256, /^[a-f0-9]{64}$/);
    assert.equal(before.runtimeCacheMD5, createHash("md5").update(header()).digest("hex"));
    const changed = header();
    changed[31] = 1;
    await writeFile(file, changed);
    assert.notEqual((await hashAppImage(file)).sha256, before.sha256);
    await writeFile(join(directory, "foreign"), "not an AppImage");
    await assert.rejects(hashAppImage(join(directory, "foreign")), /bounded|type-2/);
    if (process.platform !== "win32") {
      await symlink(file, join(directory, "alias"));
      await assert.rejects(hashAppImage(join(directory, "alias")), /regular file/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
