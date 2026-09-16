import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createManagedRuntimeProvider, ManagedRuntimeError } from "./managed-runtime.js";

const temporary: string[] = [];
const platform = "darwin";
const arch = "arm64";
const bytes = Buffer.from("This is a runtime fixture, never execute it.\n");
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture(id = "node") {
  const base = await fs.mkdtemp(join(tmpdir(), "codeshell-managed-runtime-"));
  temporary.push(base);
  const root = join(base, "runtimes");
  const runtime = join(root, id);
  const executable = join(runtime, "bin", "node");
  await fs.mkdir(dirname(executable), { recursive: true });
  await fs.writeFile(executable, bytes, { mode: 0o755 });
  await fs.writeFile(join(runtime, "LICENSE"), "Fixture license\n");
  const manifest = {
    schemaVersion: 1,
    id,
    version: "24.19.0",
    platform,
    arch,
    executable: "bin/node",
    sha256: digest(bytes),
    source: { url: "https://nodejs.org/dist/node.tar.gz", archiveSha256: "a".repeat(64) },
  };
  const writeManifest = (overrides: Record<string, unknown> = {}) =>
    fs.writeFile(join(runtime, "manifest.json"), JSON.stringify({ ...manifest, ...overrides }));
  await writeManifest();
  return { base, root, runtime, executable, manifest, writeManifest };
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

test("discovers validated metadata and resolves host-only paths without changing environment", async () => {
  const value = await fixture();
  const environment = { ...process.env };
  const provider = createManagedRuntimeProvider({ root: value.root, platform, arch });
  const metadata = {
    id: "node",
    version: "24.19.0",
    platform,
    arch,
    sha256: digest(bytes),
  };
  expect(await provider.list()).toEqual([metadata]);
  expect(await provider.resolve("node")).toEqual({
    ...metadata,
    executablePath: await fs.realpath(value.executable),
    binDirectory: await fs.realpath(dirname(value.executable)),
  });
  expect(process.env).toEqual(environment);
  expect(await fs.readFile(value.executable)).toEqual(bytes);
  expect((await fs.readdir(value.runtime)).sort()).toEqual(["LICENSE", "bin", "manifest.json"]);
});

test("missing roots and IDs are explicitly unavailable and never created", async () => {
  const value = await fixture();
  const absent = join(value.base, "absent");
  const missingRoot = createManagedRuntimeProvider({ root: absent, platform, arch });
  expect(await missingRoot.list()).toEqual([]);
  expect(await missingRoot.resolve("node")).toBeNull();
  expect(await fs.stat(absent).catch((error) => error.code)).toBe("ENOENT");
  expect(
    await createManagedRuntimeProvider({ root: value.root, platform, arch }).resolve("other"),
  ).toBeNull();
});

test("relocation preserves verified identity and returns the new host path", async () => {
  const value = await fixture();
  const relocated = join(value.base, "relocated");
  await fs.cp(value.root, relocated, { recursive: true });
  const before = await createManagedRuntimeProvider({ root: value.root, platform, arch }).resolve(
    "node",
  );
  const after = await createManagedRuntimeProvider({ root: relocated, platform, arch }).resolve(
    "node",
  );
  expect(after?.sha256).toBe(before?.sha256);
  expect(after?.version).toBe(before?.version);
  expect(after?.executablePath).toBe(await fs.realpath(join(relocated, "node/bin/node")));
  expect(after?.executablePath).not.toBe(before?.executablePath);
});

test("runtime discovery does not execute even executable fixture scripts", async () => {
  const value = await fixture();
  const marker = join(value.base, "executed");
  const script = Buffer.from(`#!/bin/sh\nprintf executed > '${marker}'\n`);
  await fs.writeFile(value.executable, script);
  await value.writeManifest({ sha256: digest(script) });
  const provider = createManagedRuntimeProvider({ root: value.root, platform, arch });
  expect((await provider.list())[0]?.id).toBe("node");
  expect((await provider.resolve("node"))?.version).toBe("24.19.0");
  expect(await fs.stat(marker).catch((error) => error.code)).toBe("ENOENT");
});

test("rejects invalid root and runtime IDs without resolving filesystem paths", async () => {
  expect(() => createManagedRuntimeProvider({ root: "relative" })).toThrow(ManagedRuntimeError);
  const value = await fixture();
  const provider = createManagedRuntimeProvider({ root: value.root, platform, arch });
  for (const id of ["../node", "/node", "node/other", "node\\other", "", "NODE", "con", "node@24"])
    await expect(provider.resolve(id)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

test("rejects malformed manifests, provenance, versions and executable path escapes", async () => {
  const value = await fixture();
  const provider = createManagedRuntimeProvider({ root: value.root, platform, arch });
  for (const overrides of [
    { schemaVersion: 2 },
    { id: "different" },
    { version: "" },
    { version: "24\nmalicious" },
    { sha256: "not-a-digest" },
    { source: { url: "file:///node", archiveSha256: "a".repeat(64) } },
    { source: { url: "https://user:password@example.com/node", archiveSha256: "a".repeat(64) } },
    { source: { url: "https://nodejs.org/node", archiveSha256: "wrong" } },
    ...[
      "../node",
      "/bin/node",
      "bin/../../node",
      "bin\\node",
      "C:/node.exe",
      "bin//node",
      "bin/./node",
      "bin/node.",
      "bin/CON.exe",
    ].map((executable) => ({ executable })),
  ]) {
    await value.writeManifest(overrides);
    await expect(provider.resolve("node")).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  }
  await fs.writeFile(join(value.runtime, "manifest.json"), "{invalid-json}");
  await expect(provider.list()).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
});

test("rejects oversized manifests and incomplete packages", async () => {
  const value = await fixture();
  const provider = createManagedRuntimeProvider({ root: value.root, platform, arch });
  await fs.writeFile(join(value.runtime, "manifest.json"), " ".repeat(16 * 1024 + 1));
  await expect(provider.resolve("node")).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  await value.writeManifest();
  await fs.rm(join(value.runtime, "LICENSE"));
  await expect(provider.resolve("node")).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  await fs.writeFile(join(value.runtime, "LICENSE"), "");
  await expect(provider.resolve("node")).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  await fs.writeFile(join(value.runtime, "LICENSE"), "License");
  await fs.rm(value.executable);
  await expect(provider.resolve("node")).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
});

test("listing rejects a runtime directory replaced by a regular file", async () => {
  const value = await fixture();
  await fs.rm(value.runtime, { recursive: true });
  await fs.writeFile(value.runtime, "not a runtime directory");
  await expect(
    createManagedRuntimeProvider({ root: value.root, platform, arch }).list(),
  ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
});

test("rejects another platform or architecture instead of falling back to PATH", async () => {
  const value = await fixture();
  await expect(
    createManagedRuntimeProvider({ root: value.root, platform: "linux", arch }).resolve("node"),
  ).rejects.toMatchObject({ code: "PLATFORM_MISMATCH" });
  await expect(
    createManagedRuntimeProvider({ root: value.root, platform, arch: "x64" }).list(),
  ).rejects.toMatchObject({ code: "PLATFORM_MISMATCH" });
});

test("supports a Windows package without requiring Unix execute bits", async () => {
  const value = await fixture();
  await fs.rename(value.executable, `${value.executable}.exe`);
  await fs.chmod(`${value.executable}.exe`, 0o644);
  await value.writeManifest({ platform: "win32", arch: "x64", executable: "bin/node.exe" });
  expect(
    (
      await createManagedRuntimeProvider({
        root: value.root,
        platform: "win32",
        arch: "x64",
      }).resolve("node")
    )?.executablePath,
  ).toBe(await fs.realpath(`${value.executable}.exe`));
});

test("revalidates bytes and executable mode on every request without stale cached grants", async () => {
  const value = await fixture();
  const provider = createManagedRuntimeProvider({ root: value.root, platform, arch });
  expect(await provider.resolve("node")).not.toBeNull();
  await fs.writeFile(value.executable, Buffer.alloc(bytes.length, 65));
  await expect(provider.resolve("node")).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  await expect(provider.list()).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  await fs.writeFile(value.executable, bytes);
  await fs.chmod(value.executable, 0o644);
  await expect(provider.resolve("node")).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
});

test("rejects symlinks at the root and every package boundary, even internal targets", async () => {
  for (const component of ["root", "runtime", "manifest.json", "LICENSE", "bin", "bin/node"]) {
    const value = await fixture();
    const path =
      component === "root"
        ? value.root
        : component === "runtime"
          ? value.runtime
          : join(value.runtime, component);
    const moved = `${path}-real`;
    await fs.rename(path, moved);
    await fs.symlink(moved, path);
    await expect(
      createManagedRuntimeProvider({ root: value.root, platform, arch }).resolve("node"),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  }
});

test("detects same-content executable replacement during hashing", async () => {
  const value = await fixture();
  const canonicalExecutable = await fs.realpath(value.executable);
  const originalOpen = fs.open;
  let replaced = false;
  const mock = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === canonicalExecutable) {
      const originalRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: any[]) => {
        const result = await (originalRead as any)(...readArgs);
        if (!replaced) {
          replaced = true;
          await fs.rename(value.executable, `${value.executable}.old`);
          await fs.writeFile(value.executable, bytes, { mode: 0o755 });
        }
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  try {
    await expect(
      createManagedRuntimeProvider({ root: value.root, platform, arch }).resolve("node"),
    ).rejects.toMatchObject({ code: "CHANGED_DURING_READ" });
    expect(replaced).toBe(true);
  } finally {
    mock.mockRestore();
  }
});

test("detects manifest replacement after it was read and before resolution completes", async () => {
  const value = await fixture();
  const canonicalExecutable = await fs.realpath(value.executable);
  const originalOpen = fs.open;
  let replaced = false;
  const mock = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === canonicalExecutable && !replaced) {
      replaced = true;
      await fs.rename(join(value.runtime, "manifest.json"), join(value.runtime, "manifest.old"));
      await value.writeManifest();
    }
    return handle;
  });
  try {
    await expect(
      createManagedRuntimeProvider({ root: value.root, platform, arch }).resolve("node"),
    ).rejects.toMatchObject({ code: "CHANGED_DURING_READ" });
    expect(replaced).toBe(true);
  } finally {
    mock.mockRestore();
  }
});
