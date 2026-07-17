import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as rootApi from "./index.js";
import * as storageApi from "./index.storage.js";
import * as workerApi from "./index.worker.js";
import * as mobileRemoteApi from "./index.mobile-remote.js";
import * as serveApi from "./index.serve.js";

const repoRoot = join(import.meta.dir, "../../..");

describe("Server package public entry contracts", () => {
  test("keeps focused entries root-compatible without crossing responsibilities", () => {
    const focusedKeys = [
      ...new Set([
        ...Object.keys(storageApi),
        ...Object.keys(workerApi),
        ...Object.keys(mobileRemoteApi),
        ...Object.keys(serveApi),
      ]),
    ].sort();
    expect(Object.keys(rootApi).sort()).toEqual(focusedKeys);
    expect(storageApi.listDiskSessions).toBe(rootApi.listDiskSessions);
    expect(workerApi.WorkerBridgeCore).toBe(rootApi.WorkerBridgeCore);
    expect(mobileRemoteApi.RemoteHostManager).toBe(rootApi.RemoteHostManager);
    expect(serveApi.startHeadlessServer).toBe(rootApi.startHeadlessServer);

    expect("RemoteHostManager" in storageApi).toBe(false);
    expect("WorkerBridgeCore" in storageApi).toBe(false);
    expect("startHeadlessServer" in storageApi).toBe(false);
    expect("listDiskSessions" in mobileRemoteApi).toBe(false);
    expect("WorkerBridgeCore" in mobileRemoteApi).toBe(false);
    expect("startHeadlessServer" in mobileRemoteApi).toBe(false);
    expect(Object.keys(workerApi).sort()).toEqual(["WorkerBridgeCore", "previewLine"]);
  });

  test("declares exact package exports and source aliases", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/server/package.json"), "utf8"),
    ) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./mobile-remote",
      "./serve",
      "./storage",
      "./worker",
    ]);
    expect(manifest.exports["./storage"]).toEqual({
      types: "./dist/index.storage.d.ts",
      import: "./dist/index.storage.js",
    });
    expect(manifest.exports["./mobile-remote"]).toEqual({
      types: "./dist/index.mobile-remote.d.ts",
      import: "./dist/index.mobile-remote.js",
    });

    const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(tsconfig.compilerOptions.paths["@cjhyy/code-shell-server/*"]).toBeUndefined();
    expect(tsconfig.compilerOptions.paths["@cjhyy/code-shell-server/storage"]).toEqual([
      "packages/server/src/index.storage.ts",
    ]);
    expect(tsconfig.compilerOptions.paths["@cjhyy/code-shell-server/mobile-remote"]).toEqual([
      "packages/server/src/index.mobile-remote.ts",
    ]);
    expect(tsconfig.compilerOptions.paths["@cjhyy/code-shell-server/serve"]).toEqual([
      "packages/server/src/index.serve.ts",
    ]);
    expect(tsconfig.compilerOptions.paths["@cjhyy/code-shell-server/worker"]).toEqual([
      "packages/server/src/index.worker.ts",
    ]);
  });

  test("keeps Coding/Web composition out of storage and transport modules", () => {
    const mobileRemotePaths = readdirSync(join(repoRoot, "packages/server/src/mobile-remote"), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .map((path) => `mobile-remote/${path}`);
    const sourcePaths = [
      "index.storage.ts",
      "index.worker.ts",
      "index.mobile-remote.ts",
      "attachment-service.ts",
      "client-message-id.ts",
      "image-byte-probe.ts",
      "sessions-service.ts",
      "worker-bridge-core.ts",
      ...mobileRemotePaths,
    ];
    const compositionImports = sourcePaths.flatMap((path) => {
      const source = readFileSync(join(repoRoot, "packages/server/src", path), "utf8");
      return source.match(/@cjhyy\/code-shell-(?:capability-coding|web)/g) ?? [];
    });
    expect(compositionImports).toEqual([]);

    const serveCli = readFileSync(join(repoRoot, "packages/server/src/serve/cli.ts"), "utf8");
    expect(serveCli).toContain("@cjhyy/code-shell-capability-coding/bin/agent-server-stdio");
    expect(serveCli).toContain("@cjhyy/code-shell-web/package.json");
  });
});
