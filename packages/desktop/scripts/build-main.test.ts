import { expect, test } from "bun:test";
import esbuild from "esbuild";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { desktopMainBuildOptions } from "./build-main.js";

test("the shared main build delivers the worker Link entry and all its shared chunks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-main-link-build-")));
  try {
    const options = desktopMainBuildOptions();
    const entries = options.entryPoints as Record<string, string>;
    expect(Object.keys(entries).sort()).toEqual(["index", "link-provider-module"]);
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

    // Follow the real two-entry build graph. A provider-only build would miss
    // runtime dependencies introduced by a chunk shared with Electron Main.
    const visited = new Set<string>();
    const external = new Set<string>();
    const pending = [entry![0]];
    while (pending.length) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const output = outputs.get(path);
      expect(output, `undelivered worker Link chunk: ${path}`).toBeDefined();
      for (const dependency of output!.imports) {
        if (dependency.external) external.add(dependency.path);
        else {
          const fromCwd = resolve(dependency.path);
          pending.push(outputs.has(fromCwd) ? fromCwd : resolve(dirname(path), dependency.path));
        }
      }
    }
    expect(external.has("@cjhyy/code-shell-core/extension")).toBe(true);
    expect(external.has("@cjhyy/code-shell-link")).toBe(true);
    expect(
      [...external].filter(
        (specifier) =>
          !isBuiltin(specifier) && !/^@cjhyy\/code-shell-(?:core|link)(?:\/|$)/.test(specifier),
      ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
