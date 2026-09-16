import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesktopManagedRuntimeProvider,
  createManagedRuntimeHandlers,
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
});
