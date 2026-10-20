import { readFileSync } from "node:fs";
import { installLocalNetworkGuard } from "../runtime-cost-smoke-isolation.mjs";

// Bun's isolated workspace linker does not expose Server as a root dependency.
// Locate its public ESM export without loading it; callers must install their
// exact-origin guard before dynamically importing this reviewed entry.
const serverPackageUrl = new URL("../../packages/server/package.json", import.meta.url);
const serverPackage = JSON.parse(readFileSync(serverPackageUrl, "utf8"));
export const linkProviderModuleUrl = new URL(
  serverPackage.exports["./links"].import,
  serverPackageUrl,
).href;

/** OAuth fixtures inspect redirects, but may only send to their owned origin. */
export function installLinkFlowNetworkGuard(origin) {
  const originalFetch = globalThis.fetch;
  installLocalNetworkGuard(origin);
  globalThis.fetch = (input, init) => {
    const target = typeof input === "string" || input instanceof URL ? input : input.url;
    if (new URL(target).origin !== origin)
      throw new Error("Link smoke refused a non-fixture request");
    if (init?.dispatcher || (init?.redirect && !["manual", "error"].includes(init.redirect)))
      throw new Error("Link smoke refused an unreviewed fetch transport or redirect");
    return originalFetch(input, { ...init, redirect: init?.redirect ?? "error" });
  };
}
