import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DESKTOP_LINK_PROVIDER_BUNDLE } from "../src/main/link-provider-module.js";
import { buildWorkerLinkProviders } from "./build-worker-link-providers.js";

test("the production worker Link build emits one factory with only delivered runtime imports", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-link-bundle-build-")));
  try {
    const outfile = join(root, "应用 app.asar", DESKTOP_LINK_PROVIDER_BUNDLE);
    const built = await buildWorkerLinkProviders({
      desktopRoot: resolve(import.meta.dir, ".."),
      outfile,
    });
    const outputs = Object.values(built.metafile!.outputs);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.exports).toEqual(["createLinkProviderModule"]);
    const external = outputs[0]!.imports
      .filter((entry) => entry.external)
      .map((entry) => entry.path);
    expect(external).toContain("@cjhyy/code-shell-core/extension");
    expect(external).toContain("@cjhyy/code-shell-link");
    expect(
      external.filter(
        (specifier) =>
          !isBuiltin(specifier) && !/^@cjhyy\/code-shell-(?:core|link)(?:\/|$)/.test(specifier),
      ),
    ).toEqual([]);
    expect(
      Object.keys(built.metafile!.inputs).some((input) => /links\/providers\//.test(input)),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
