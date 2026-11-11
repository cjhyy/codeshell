import { expect, test } from "bun:test";
import esbuild from "esbuild";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { desktopMainBuildOptions } from "./build-main.js";

test("the shared main build delivers the worker Link and Cua proxy entries with their shared chunks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-main-link-build-")));
  try {
    const options = desktopMainBuildOptions();
    const entries = options.entryPoints as Record<string, string>;
    expect(Object.keys(entries).sort()).toEqual([
      "activity-history-worker",
      "cua-activity-proxy",
      "index",
      "link-provider-module",
      "session-transcript-cache-worker",
    ]);
    const result = await esbuild.build({
      ...options,
      outdir: join(root, "应用 app.asar/out/main"),
      metafile: true,
      logLevel: "silent",
    });
    const outputs = new Map(
      Object.entries(result.metafile!.outputs).map(([path, output]) => [resolve(path), output]),
    );
    const entry = [...outputs].find(([path]) => path.endsWith("link-provider-module.mjs"));
    expect(entry).toBeDefined();
    expect(entry![1].exports).toEqual(["createLinkProviderModule"]);
    expect([...outputs.keys()].some((path) => path.endsWith("index.mjs"))).toBe(true);

    // Follow the real multi-entry build graph. A provider-only build would miss
    // runtime dependencies introduced by a chunk shared with Electron Main.
    const externalsOf = (start: string) => {
      const visited = new Set<string>();
      const external = new Set<string>();
      const pending = [start];
      while (pending.length) {
        const path = pending.pop()!;
        if (visited.has(path)) continue;
        visited.add(path);
        const output = outputs.get(path);
        expect(output, `undelivered chunk: ${path}`).toBeDefined();
        for (const dependency of output!.imports) {
          if (dependency.external) external.add(dependency.path);
          else {
            const fromCwd = resolve(dependency.path);
            pending.push(outputs.has(fromCwd) ? fromCwd : resolve(dirname(path), dependency.path));
          }
        }
      }
      return external;
    };
    const external = externalsOf(entry![0]);
    expect(external.has("@cjhyy/code-shell-core/extension")).toBe(true);
    expect(external.has("@cjhyy/code-shell-link")).toBe(true);
    expect(
      [...external].filter(
        (specifier) =>
          !isBuiltin(specifier) && !/^@cjhyy\/code-shell-(?:core|link)(?:\/|$)/.test(specifier),
      ),
    ).toEqual([]);

    // The Cua proxy is the MCP stdio server core spawns with ELECTRON_RUN_AS_NODE,
    // so it can import neither Electron nor the workspace packages.
    const proxy = [...outputs.keys()].find((path) => path.endsWith("cua-activity-proxy.mjs"));
    expect(proxy).toBeDefined();
    expect([...externalsOf(proxy!)].filter((specifier) => !isBuiltin(specifier))).toEqual([]);
    const cache = [...outputs.keys()].find((path) =>
      path.endsWith("session-transcript-cache-worker.mjs"),
    );
    expect(cache).toBeDefined();
    expect(
      [...externalsOf(cache!)].filter(
        (specifier) => !isBuiltin(specifier) && !/^@cjhyy\/code-shell-core(?:\/|$)/.test(specifier),
      ),
    ).toEqual([]);
    const history = [...outputs.keys()].find((path) =>
      path.endsWith("activity-history-worker.mjs"),
    );
    expect(history).toBeDefined();
    expect(
      [...externalsOf(history!)].filter(
        (specifier) => !isBuiltin(specifier) && !/^@cjhyy\/code-shell-core(?:\/|$)/.test(specifier),
      ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
