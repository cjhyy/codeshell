import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const runtime = require("./managed-node-runtime.cjs");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "codeshell-managed-node-"));
  directories.push(path);
  return path;
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function binary(platform: string, arch: string) {
  const bytes = Buffer.alloc(128);
  if (platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  } else if (platform === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  } else {
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(64, 0x3c);
    bytes.writeUInt32LE(0x00004550, 64);
    bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 68);
  }
  return bytes;
}
function tarArchive(files: Record<string, Buffer>) {
  const parts: Buffer[] = [];
  for (const [name, data] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000755\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
function zipArchive(files: Record<string, Buffer>, method = 8) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let position = 0;
  for (const [filename, bytes] of Object.entries(files)) {
    const name = Buffer.from(filename),
      data = method === 8 ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(position, 42);
    locals.push(local, name, data);
    central.push(entry, name);
    position += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, directory, end]);
}
function fixture(platform = "darwin", arch = "arm64", executable = binary(platform, arch)) {
  const root = `node-v24.21.0-${platform === "win32" ? "win" : platform}-${arch}`;
  const files = {
    [`${root}/${platform === "win32" ? "node.exe" : "bin/node"}`]: executable,
    [`${root}/LICENSE`]: Buffer.from("Fixture complete license\n"),
    [`${root}/unrequested`]: Buffer.from("never extracted"),
  };
  const bytes = platform === "win32" ? zipArchive(files) : tarArchive(files);
  const artifact = {
    platform,
    arch,
    url: `https://nodejs.org/dist/v24.21.0/${root}.${platform === "win32" ? "zip" : "tar.gz"}`,
    archiveSha256: hash(bytes),
  };
  const lock = {
    schemaVersion: 1,
    id: "node",
    version: "24.21.0",
    checksumsUrl: "https://nodejs.org/dist/v24.21.0/SHASUMS256.txt",
    artifacts: [artifact],
  };
  return { bytes, artifact, lock, platform, arch, fetch: async () => new Response(bytes) };
}
async function options(input = fixture()) {
  const root = await temporary();
  return { ...input, cacheDir: join(root, "cache"), runtimeDir: join(root, "node") };
}

describe("managed Node supply", () => {
  test("checked-in lock contains only the four reviewed official targets", async () => {
    const lock = await runtime.loadLock();
    expect(lock.version).toBe("24.21.0");
    expect(lock.artifacts.map((item) => `${item.platform}-${item.arch}`).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "win32-x64",
    ]);
    expect(() => runtime.selectArtifact(lock, "linux", "arm64")).toThrow("not locked");
    expect(() =>
      runtime.validateLock({
        ...lock,
        artifacts: [{ ...lock.artifacts[0], url: "https://example.com/node" }],
      }),
    ).toThrow("Invalid");
    expect(() =>
      runtime.validateLock({ ...lock, artifacts: [lock.artifacts[0], lock.artifacts[0]] }),
    ).toThrow("Invalid");
  });
  test("packaging uses builder's target architecture and real resource directory", () => {
    const context = {
      electronPlatformName: "darwin",
      arch: 1,
      appOutDir: "/build",
      packager: { appInfo: { productFilename: "code-shell" } },
    };
    expect(runtime.packagingTarget(context)).toEqual({ platform: "darwin", arch: "x64" });
    expect(runtime.packagedRuntimeDirectory(context)).toBe(
      "/build/code-shell.app/Contents/Resources/runtimes/node",
    );
    expect(runtime.packagingTarget({ ...context, arch: 3 })).toEqual({
      platform: "darwin",
      arch: "arm64",
    });
    expect(() => runtime.packagingTarget({ ...context, arch: 4 })).toThrow("Unsupported");
    expect(runtime.packagedRuntimeDirectory({ ...context, electronPlatformName: "win32" })).toBe(
      "/build/resources/runtimes/node",
    );
  });
  test("downloads with redirect rejection and verifies cache again when offline", async () => {
    const input = await options();
    let calls = 0;
    const prepared = await runtime.prepareArchive({
      ...input,
      fetch: async (url, init) => {
        calls++;
        expect(url).toBe(input.artifact.url);
        expect(init.redirect).toBe("error");
        return new Response(input.bytes);
      },
    });
    expect(await readFile(prepared.archive)).toEqual(input.bytes);
    const offline = await runtime.prepareArchive({
      ...input,
      offline: true,
      fetch: () => {
        throw new Error("network forbidden");
      },
    });
    expect(offline.archive).toBe(prepared.archive);
    expect(calls).toBe(1);
    await writeFile(prepared.archive, "corrupt");
    await expect(runtime.prepareArchive({ ...input, offline: true })).rejects.toThrow(
      "offline cache",
    );
  });
  test("missing offline cache fails before fetch", async () => {
    const input = await options();
    await expect(
      runtime.prepareArchive({
        ...input,
        offline: true,
        fetch: () => {
          throw new Error("unexpected fetch");
        },
      }),
    ).rejects.toThrow("offline cache");
    expect(await readdir(input.cacheDir)).toEqual([]);
  });
  test("checksum failure leaves no partial or accepted archive", async () => {
    const input = await options();
    await expect(
      runtime.prepareArchive({ ...input, fetch: async () => new Response("wrong bytes") }),
    ).rejects.toThrow("checksum mismatch");
    expect(await readdir(input.cacheDir)).toEqual([]);
  });
  test("corrupted online cache is replaced only by verified bytes", async () => {
    const input = await options();
    const { archive } = await runtime.prepareArchive(input);
    await writeFile(archive, "corrupt");
    await expect(
      runtime.prepareArchive({ ...input, fetch: async () => new Response("still wrong") }),
    ).rejects.toThrow("checksum mismatch");
    expect(await readFile(archive, "utf8")).toBe("corrupt");
    await runtime.prepareArchive(input);
    expect(await readFile(archive)).toEqual(input.bytes);
  });
  test("oversized header and oversized stream both reject with cleanup", async () => {
    const input = await options();
    await expect(
      runtime.prepareArchive({
        ...input,
        fetch: async () =>
          new Response(input.bytes, {
            headers: { "content-length": String(runtime.LIMITS.archive + 1) },
          }),
      }),
    ).rejects.toThrow("size limit");
    await expect(runtime.prepareArchive({ ...input, maxArchiveBytes: 10 })).rejects.toThrow(
      "size limit",
    );
    expect(await readdir(input.cacheDir)).toEqual([]);
  });
  test("download timeout aborts rather than waiting indefinitely", async () => {
    const input = await options();
    await expect(
      runtime.prepareArchive({
        ...input,
        timeoutMs: 5,
        fetch: (_url, init) =>
          new Promise((_accept, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      }),
    ).rejects.toThrow("timed out");
    expect(await readdir(input.cacheDir)).toEqual([]);
  });
  test("cache symlinks cannot redirect reads or writes", async () => {
    const input = await options();
    await mkdir(input.cacheDir);
    const outside = join(input.cacheDir, "outside");
    await writeFile(outside, input.bytes);
    const archive = join(
      input.cacheDir,
      `${input.artifact.archiveSha256}-${basename(new URL(input.artifact.url).pathname)}`,
    );
    await symlink(outside, archive);
    await expect(runtime.prepareArchive(input)).rejects.toThrow("regular file");
    expect(await readFile(outside)).toEqual(input.bytes);
  });
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["win32", "x64"],
  ]) {
    test(`stages only executable, LICENSE and manifest for ${platform}-${arch}`, async () => {
      const input = await options(fixture(platform, arch));
      const { runtimeDir, manifest } = await runtime.stageRuntime(input);
      expect((await readdir(runtimeDir)).sort()).toEqual(["LICENSE", "bin", "manifest.json"]);
      expect(manifest).toEqual({
        schemaVersion: 1,
        id: "node",
        version: "24.21.0",
        platform,
        arch,
        executable: platform === "win32" ? "bin/node.exe" : "bin/node",
        sha256: hash(binary(platform, arch)),
        source: { url: input.artifact.url, archiveSha256: input.artifact.archiveSha256 },
      });
      expect(await runtime.verifyRuntime(runtimeDir, input)).toEqual(manifest);
      expect(await readFile(join(runtimeDir, "LICENSE"), "utf8")).toBe(
        "Fixture complete license\n",
      );
    });
  }
  test("wrong target bytes cannot replace an existing runtime", async () => {
    const input = await options();
    await runtime.stageRuntime(input);
    const before = await readFile(join(input.runtimeDir, "manifest.json"), "utf8");
    const wrong = fixture("darwin", "arm64", binary("darwin", "x64"));
    await expect(runtime.stageRuntime({ ...input, ...wrong })).rejects.toThrow(
      "architecture mismatch",
    );
    expect(await readFile(join(input.runtimeDir, "manifest.json"), "utf8")).toBe(before);
    expect(
      (await readdir(join(input.runtimeDir, ".."))).filter((name) =>
        name.startsWith(".node-runtime-"),
      ),
    ).toEqual([]);
  });
  test("output symlink cannot be replaced", async () => {
    const input = await options();
    const actual = `${input.runtimeDir}-actual`;
    await mkdir(actual);
    await symlink(actual, input.runtimeDir);
    await expect(runtime.stageRuntime(input)).rejects.toThrow("real directory");
    expect(await readdir(actual)).toEqual([]);
  });
  test("verification rejects tampering; signing refresh records final bytes", async () => {
    const input = await options();
    await runtime.stageRuntime(input);
    const executable = join(input.runtimeDir, "bin/node");
    const signed = Buffer.concat([
      binary(input.platform, input.arch),
      Buffer.from("signature bytes"),
    ]);
    await writeFile(executable, signed);
    await expect(runtime.verifyRuntime(input.runtimeDir, input)).rejects.toThrow(
      "checksum mismatch",
    );
    const manifest = await runtime.refreshManifest(input.runtimeDir, input);
    expect(manifest.sha256).toBe(hash(signed));
    expect(await runtime.verifyRuntime(input.runtimeDir, input)).toEqual(manifest);
    manifest.source.url = "https://example.com/node";
    await writeFile(join(input.runtimeDir, "manifest.json"), JSON.stringify(manifest));
    await expect(runtime.verifyRuntime(input.runtimeDir, input)).rejects.toThrow("locked target");
  });
  test("verification rejects an executable symlink even when bytes match", async () => {
    const input = await options();
    await runtime.stageRuntime(input);
    const executable = join(input.runtimeDir, "bin/node"),
      outside = join(input.runtimeDir, "outside");
    await writeFile(outside, await readFile(executable));
    await rm(executable);
    await symlink(outside, executable);
    await expect(runtime.verifyRuntime(input.runtimeDir, input)).rejects.toThrow("regular file");
  });
  test("ZIP parser supports stored entries, bounds output and rejects damaged headers", async () => {
    const root = await temporary(),
      archive = join(root, "fixture.zip");
    await writeFile(archive, zipArchive({ "root/node.exe": Buffer.from("payload") }, 0));
    await runtime.extractZipMember(archive, "root/node.exe", join(root, "node.exe"), 20);
    expect(await readFile(join(root, "node.exe"), "utf8")).toBe("payload");
    await expect(
      runtime.extractZipMember(archive, "root/node.exe", join(root, "small"), 1),
    ).rejects.toThrow("ZIP member");
    await writeFile(archive, Buffer.alloc(40));
    await expect(
      runtime.extractZipMember(archive, "root/node.exe", join(root, "invalid"), 20),
    ).rejects.toThrow("ZIP directory");
  });
});
