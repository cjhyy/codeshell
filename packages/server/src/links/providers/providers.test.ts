import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("public Core starts without providers and explicit Host composition installs reviewed executors", async () => {
  const root = fileURLToPath(new URL("../../../../..", import.meta.url));
  const cache = join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "link-provider-sdk-"));
  try {
    const built = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      outdir: directory,
      target: "node",
      format: "esm",
      external: [
        "@cjhyy/code-shell-core",
        "@cjhyy/code-shell-core/extension",
        "@cjhyy/code-shell-link",
      ],
    });
    expect(built.success).toBe(true);
    const script = `
      import assert from "node:assert/strict";
      import http from "node:http";
      import https from "node:https";
      let requests = 0;
      const deny = () => { requests++; throw new Error("SDK composition network denied"); };
      globalThis.fetch = deny;
      http.request = deny; https.request = deny;
      const core = await import("@cjhyy/code-shell-core");
      assert.deepEqual(core.listLocalLinkProviders(), []);
      assert.equal(core.getLocalLinkProvider("figma"), undefined);
      const product = await import(${JSON.stringify(built.outputs[0]!.path)});
      assert.deepEqual(core.listLocalLinkProviders(), [], "importing a product factory must not install it");
      product.installDefaultLinkProviders();
      product.installDefaultLinkProviders();
      assert.equal(core.listLocalLinkProviders().length, 10);
      assert.equal(product.createLinkProviderModule().id, "codeshell-link-providers");
      const summary = core.getLocalLinkProvider("figma").actions.find(action => action.id === "get_file");
      await assert.rejects(summary.execute({ token: "synthetic", params: { file_key: "Fixture", depth: 2 } }),
        error => error.code === "invalid_input");
      assert.equal(requests, 0, "contracts reject inputs before physical provider IO");
      process.stdout.write("ok");
    `;
    const result = spawnSync(
      process.execPath.endsWith("bun") ? "node" : process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root, env: process.env, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("ok");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP adapters preserve accepted GitHub pages/state and Vercel project identity", async () => {
  const { createDefaultLinkProviders } = await import("./defaults.js");
  const providers = createDefaultLinkProviders();
  const calls: URL[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(["https://api.github.com", "https://api.vercel.com"]).toContain(url.origin);
    expect(init?.redirect).toBe("error");
    calls.push(url);
    return new Response(
      JSON.stringify(
        url.pathname.includes("deployments")
          ? {
              deployments: [
                { uid: "deployment", projectId: "prj_selected", name: "unrelated-label" },
              ],
            }
          : [],
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  const github = providers.find((provider) => provider.id === "github")!;
  await github.actions
    .find((action) => action.id === "list_issues")!
    .execute({
      token: "synthetic",
      params: { owner: "owner", repo: "repo", limit: 4, page: 1500, state: "closed" },
      fetchImpl,
    });
  expect(Object.fromEntries(calls.at(-1)!.searchParams)).toEqual({
    per_page: "4",
    page: "1000",
    state: "closed",
  });
  await github.actions
    .find((action) => action.id === "list_pull_requests")!
    .execute({
      token: "synthetic",
      params: { owner: "owner", repo: "repo", page: 3 },
      fetchImpl,
    });
  expect(calls.at(-1)!.searchParams.get("page")).toBe("3");
  const vercel = providers.find((provider) => provider.id === "vercel")!;
  const result = await vercel.actions
    .find((action) => action.id === "list_deployments")!
    .execute({
      token: "synthetic",
      params: {},
      fetchImpl,
    });
  expect(result).toMatchObject({
    deployments: [{ projectId: "prj_selected", name: "unrelated-label" }],
  });
});
