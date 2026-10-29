import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopManagedRuntimeWiring } from "./managed-runtime-wiring.js";

test("composition lazily verifies app-owned Node on each launch and never falls back to PATH", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-wiring-")));
  let reads = 0;
  const wiring = createDesktopManagedRuntimeWiring(
    {
      isPackaged: true,
      getAppPath: () => {
        reads++;
        return root;
      },
    },
    join(root, "resources"),
  );
  try {
    expect(reads).toBe(0);
    expect(await wiring.resolveBackgroundServiceNode()).toBeNull();
    const runtime = join(root, "resources/runtimes/node"),
      executable = join(runtime, "bin/node");
    const bytes = "fixture runtime, never executed";
    await mkdir(join(runtime, "bin"), { recursive: true });
    await writeFile(executable, bytes, { mode: 0o755 });
    await writeFile(join(runtime, "LICENSE"), "fixture license");
    await writeFile(
      join(runtime, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "node",
        version: "24.22.1",
        platform: process.platform,
        arch: process.arch,
        executable: "bin/node",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        source: { url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256: "a".repeat(64) },
      }),
    );
    expect(await wiring.resolveBackgroundServiceNode()).toBe(executable);
    await writeFile(executable, "tampered bytes");
    await expect(wiring.resolveBackgroundServiceNode()).rejects.toThrow(/hash|checksum|SHA-256/i);
    const handlers = new Map<string, (...args: any[]) => any>();
    wiring.registerIpc(
      {
        handle: (name, handler) => {
          handlers.set(name, handler);
        },
      },
      (event: any) => event.host === true,
    );
    expect(() => handlers.get("managed-runtimes:resolve")!({ host: false }, "node")).toThrow(
      "Desktop host sender",
    );
    await expect(handlers.get("managed-runtimes:resolve")!({ host: true }, "node")).rejects.toThrow(
      /hash|checksum|SHA-256/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
