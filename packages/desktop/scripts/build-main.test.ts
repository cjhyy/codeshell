import { test, expect } from "bun:test";
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { desktopMainBuildOptions } from "./build-main.js";

test("the bundled worker Link module registers providers without a Server package", async () => {
  const isolated = mkdtempSync(resolve(tmpdir(), "codeshell-link-module-"));
  try {
    const options = desktopMainBuildOptions();
    const entries = options.entryPoints as Record<string, string>;
    // Use the same entry/configuration as production, without launching Electron.
    const result = await esbuild.build({
      ...options,
      entryPoints: { "link-provider-module": entries["link-provider-module"]! },
      outdir: resolve(isolated, "out/main"),
      metafile: true,
      logLevel: "silent",
    });
    const externalImports = Object.values(result.metafile!.outputs).flatMap((output) =>
      output.imports.filter((entry) => entry.external).map((entry) => entry.path),
    );
    expect(externalImports).toContain("@cjhyy/code-shell-core/extension");
    expect(externalImports).not.toContain("@cjhyy/code-shell-server/links");
    expect(externalImports).not.toContain("@cjhyy/code-shell-link");

    // Supply the real Core registry, plus inert helpers for this registration-only
    // fixture. Full Core/worker startup is covered by the packaged Electron smoke.
    const core = resolve(isolated, "node_modules/@cjhyy/code-shell-core");
    mkdirSync(core, { recursive: true });
    writeFileSync(
      resolve(core, "package.json"),
      JSON.stringify({
        name: "@cjhyy/code-shell-core",
        type: "module",
        exports: { ".": "./fixture.mjs", "./extension": "./fixture.mjs" },
      }),
    );
    const registrySource = resolve(import.meta.dir, "../../core/src/links/providers.ts");
    const registry = await esbuild.transform(readFileSync(registrySource, "utf8"), {
      loader: "ts",
      format: "esm",
    });
    writeFileSync(resolve(core, "registry.mjs"), registry.code);
    const helpers = [
      "githubSourceEndpoint",
      "normalizeGithubSourceResult",
      "slackSourceParams",
      "normalizeSlackSourceResult",
      "githubIssueStateParameters",
      "githubRepositoryParameters",
      "githubSetStarredParameters",
      "figmaActionEndpoint",
      "figmaActionParameters",
      "normalizeFigmaActionResult",
      "asArray",
      "asRecord",
      "firstString",
      "intParam",
      "linkRequestJson",
      "linkRequestStatus",
      "pathParam",
      "pathSegmentParam",
      "pick",
      "stringParam",
      "createHardenedOAuthFetch",
      "CredentialStore",
      "beginRemoteLinkAuthorization",
      "completeRemoteLinkAuthorization",
      "revokeRemoteLinkAuthorization",
      "isRemoteLinkCredential",
      "connectCliLink",
      "getCliLinkStatus",
      "isCliLinkProvider",
      "isCredentialSecretAvailable",
      "summarizeOAuthCredentialSecret",
    ];
    writeFileSync(
      resolve(core, "fixture.mjs"),
      [
        'export * from "./registry.mjs";',
        'const unused = () => { throw new Error("Unexpected Core helper invocation"); };',
        ...helpers.map((name) => `export const ${name} = unused;`),
        'export const GITHUB_SOURCE_ACTIONS = ["list_pull_request_files", "list_pull_request_commits", "get_commit"];',
        "export const FIGMA_RESPONSE_BYTES = 1048576;",
        'export const FIGMA_RESPONSE_TOO_LARGE = "fixture response limit";',
        "export const REMOTE_LINK_PROVIDER_ADAPTERS = [];",
      ].join("\n"),
    );
    writeFileSync(
      resolve(isolated, "probe.mjs"),
      `import assert from "node:assert/strict";
       import { listLocalLinkProviders, getLocalLinkProvider } from "@cjhyy/code-shell-core/extension";
       globalThis.fetch = () => { throw new Error("Network forbidden"); };
       assert.throws(() => import.meta.resolve("@cjhyy/code-shell-server/links"),
         { code: "ERR_MODULE_NOT_FOUND" });
       assert.equal(listLocalLinkProviders().length, 0);
       const { createLinkProviderModule } = await import("./out/main/link-provider-module.mjs");
       assert.equal(createLinkProviderModule().id, "codeshell-link-providers");
       assert.deepEqual(listLocalLinkProviders().map(provider => provider.id).sort(),
         ["airtable", "figma", "github", "gitlab", "linear", "notion", "sentry", "slack", "todoist", "vercel"]);
       assert.ok(getLocalLinkProvider("figma").actions.some(action => action.id === "read_design_content"));
       createLinkProviderModule();
       assert.equal(listLocalLinkProviders().length, 10);
       console.log("isolated Link module passed");`,
    );
    const output = execFileSync("node", [resolve(isolated, "probe.mjs")], {
      cwd: isolated,
      env: { PATH: process.env.PATH, HOME: isolated, TMPDIR: isolated },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(output.trim()).toBe("isolated Link module passed");
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
