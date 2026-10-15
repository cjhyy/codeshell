import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDesktopManagedRuntimeProvider,
  createManagedRuntimeHandlers,
  injectDesktopManagedRuntimePath,
} from "./managed-runtime-service.js";

describe("Desktop managed runtime discovery", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-managed-runtime-")));
    roots.push(root);
    const options = {
      isPackaged: true,
      resourcesPath: join(root, "installed-resources"),
      appPath: join(root, "source"),
      platform: "darwin" as const,
      arch: "arm64",
    };
    async function install(runtimeRoot: string, version: string) {
      const directory = join(runtimeRoot, "node");
      await mkdir(join(directory, "bin"), { recursive: true });
      const bytes = Buffer.from(`fixture for ${version}; not executable JavaScript`);
      await writeFile(join(directory, "bin", "node"), bytes, { mode: 0o755 });
      await writeFile(join(directory, "LICENSE"), "Runtime fixture license");
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "node",
          version,
          platform: "darwin",
          arch: "arm64",
          executable: "bin/node",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          source: { url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256: "a".repeat(64) },
        }),
      );
      return join(directory, "bin", "node");
    }
    return { options, install };
  }

  test("packaged and development hosts discover only their own configured resources", async () => {
    const { options, install } = await fixture();
    const packaged = await install(join(options.resourcesPath, "runtimes"), "24.21.0");
    const development = await install(join(options.appPath, "out", "managed-runtimes"), "24.20.0");
    const before = { ...process.env };
    const installedProvider = createDesktopManagedRuntimeProvider(options);
    const developmentProvider = createDesktopManagedRuntimeProvider({
      ...options,
      isPackaged: false,
    });

    expect((await installedProvider.resolve("node"))?.executablePath).toBe(packaged);
    expect((await developmentProvider.resolve("node"))?.executablePath).toBe(development);
    expect(await installedProvider.list()).toHaveLength(1);
    expect(await developmentProvider.list()).toHaveLength(1);
    expect(process.env).toEqual(before);
  });

  test("missing packaged resources do not fall back to a developer or system runtime", async () => {
    const { options, install } = await fixture();
    await install(join(options.appPath, "out", "managed-runtimes"), "24.21.0");
    const provider = createDesktopManagedRuntimeProvider(options);
    expect(await provider.list()).toEqual([]);
    expect(await provider.resolve("node")).toBeNull();
  });

  test("Desktop discovery rejects non-host callers before accessing runtime files", async () => {
    const { options, install } = await fixture();
    const executablePath = await install(join(options.resourcesPath, "runtimes"), "24.21.0");
    const handlers = createManagedRuntimeHandlers(
      createDesktopManagedRuntimeProvider(options),
      (event: { host: boolean }) => event.host,
    );
    expect(() => handlers.list({ host: false })).toThrow("Desktop host sender");
    expect(() => handlers.resolve({ host: false }, "node")).toThrow("Desktop host sender");
    expect(() => handlers.resolve({ host: true }, null)).toThrow("must be a string");
    expect((await handlers.resolve({ host: true }, "node"))?.executablePath).toBe(executablePath);
    expect(await handlers.list({ host: true })).toHaveLength(1);
  });

  test("appends Host directories and verified Node after the user's executables", async () => {
    const { options, install } = await fixture();
    const executablePath = await install(join(options.resourcesPath, "runtimes"), "24.21.0");
    const userBin = join(options.appPath, "user-bin");
    const managedBin = join(options.appPath, "managed-bin");
    await mkdir(userBin, { recursive: true });
    await writeFile(join(userBin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { PATH: userBin };

    expect(
      await injectDesktopManagedRuntimePath({
        ...options,
        env,
        additionalDirectories: [managedBin],
      }),
    ).toEqual({ nodeAvailable: true, addedPathEntryCount: 2 });
    expect(env.PATH).toBe(`${userBin}:${managedBin}:${dirname(executablePath)}`);
    // A real shell selects the original user Node, while a PATH without one
    // selects the appended runtime. Neither fixture executable needs to run.
    if (process.platform !== "win32") {
      const lookup = (path: string) =>
        spawnSync("/bin/sh", ["-c", "command -v node"], {
          env: { PATH: path },
          encoding: "utf8",
        });
      const preferred = lookup(env.PATH);
      expect(preferred.status).toBe(0);
      expect(preferred.stdout.trim()).toBe(join(userBin, "node"));
      const fallback = lookup(`${managedBin}:${dirname(executablePath)}`);
      expect(fallback.status).toBe(0);
      expect(fallback.stdout.trim()).toBe(executablePath);
    }
    await expect(access(managedBin)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("adds the future user-bin without creating it when packaged Node is absent", async () => {
    const { options, install } = await fixture();
    await install(join(options.appPath, "out", "managed-runtimes"), "24.21.0");
    const managedBin = join(options.appPath, "managed-bin");
    const env = { PATH: "/user/bin:/usr/bin" };

    expect(
      await injectDesktopManagedRuntimePath({
        ...options,
        env,
        additionalDirectories: [managedBin],
      }),
    ).toEqual({ nodeAvailable: false, addedPathEntryCount: 1 });
    expect(env.PATH).toBe(`/user/bin:/usr/bin:${managedBin}`);
    await expect(access(managedBin)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await injectDesktopManagedRuntimePath({ ...options, env })).toEqual({
      nodeAvailable: false,
      addedPathEntryCount: 0,
    });
  });

  test("repeated injection keeps the original PATH bytes and does not duplicate directories", async () => {
    const { options, install } = await fixture();
    const executablePath = await install(join(options.resourcesPath, "runtimes"), "24.21.0");
    const managedBin = join(options.appPath, "managed-bin");
    const env = { PATH: `/user/bin::${managedBin}:` };
    const input = { ...options, env, additionalDirectories: [managedBin, managedBin] };
    expect(await injectDesktopManagedRuntimePath(input)).toEqual({
      nodeAvailable: true,
      addedPathEntryCount: 1,
    });
    const firstPath = env.PATH;
    expect(firstPath).toBe(`/user/bin::${managedBin}::${dirname(executablePath)}`);
    expect(await injectDesktopManagedRuntimePath(input)).toEqual({
      nodeAvailable: true,
      addedPathEntryCount: 0,
    });
    expect(env.PATH).toBe(firstPath);
  });

  test("rejects altered runtime bytes without changing PATH, including after an earlier injection", async () => {
    const { options, install } = await fixture();
    const executablePath = await install(join(options.resourcesPath, "runtimes"), "24.21.0");
    const env = { PATH: "/user/bin" };
    await injectDesktopManagedRuntimePath({ ...options, env });
    const before = { ...env };
    await writeFile(executablePath, "modified runtime fixture");

    await expect(
      injectDesktopManagedRuntimePath({
        ...options,
        env,
        additionalDirectories: [join(options.appPath, "new-bin")],
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(env).toEqual(before);
  });

  test("uses Windows delimiters, existing Path casing and case-insensitive duplicate checks", async () => {
    const { options } = await fixture();
    const env = { Path: "C:\\User\\bin;C:\\Windows" };
    expect(
      await injectDesktopManagedRuntimePath({
        ...options,
        platform: "win32",
        env,
        additionalDirectories: ["C:\\Managed\\bin", "c:\\managed\\BIN"],
      }),
    ).toEqual({ nodeAvailable: false, addedPathEntryCount: 1 });
    expect(env).toEqual({ Path: "C:\\User\\bin;C:\\Windows;C:\\Managed\\bin" });
  });

  test("uses POSIX delimiters with an initially absent PATH", async () => {
    const { options } = await fixture();
    const env: NodeJS.ProcessEnv = {};
    expect(
      await injectDesktopManagedRuntimePath({
        ...options,
        platform: "linux",
        env,
        additionalDirectories: ["/managed/bin", "/fallback/bin"],
      }),
    ).toEqual({ nodeAvailable: false, addedPathEntryCount: 2 });
    expect(env.PATH).toBe("/managed/bin:/fallback/bin");
  });
});
