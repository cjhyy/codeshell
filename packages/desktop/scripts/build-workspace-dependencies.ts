import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export const DESKTOP_WORKSPACE_BUILD_ORDER = [
  { label: "Link", packageName: "@cjhyy/code-shell-link", relativeDir: "packages/link" },
  { label: "core", packageName: "@cjhyy/code-shell-core", relativeDir: "packages/core" },
  { label: "pet", packageName: "@cjhyy/code-shell-pet", relativeDir: "packages/pet" },
  { label: "arena", packageName: "@cjhyy/code-shell-arena", relativeDir: "packages/arena" },
  {
    label: "coding",
    packageName: "@cjhyy/code-shell-capability-coding",
    relativeDir: "packages/coding",
  },
  { label: "cdp", packageName: "@cjhyy/code-shell-cdp", relativeDir: "packages/cdp" },
  { label: "web", packageName: "@cjhyy/code-shell-web", relativeDir: "packages/web" },
  {
    label: "server",
    packageName: "@cjhyy/code-shell-server",
    relativeDir: "packages/server",
  },
  { label: "chat", packageName: "@cjhyy/code-shell-chat", relativeDir: "packages/chat" },
] as const;

export function buildDesktopWorkspaceDependencies(): void {
  for (const { label, relativeDir } of DESKTOP_WORKSPACE_BUILD_ORDER) {
    const dir = resolve(repoRoot, relativeDir);
    if (!existsSync(resolve(dir, "package.json"))) {
      throw new Error(`${label} workspace package not found at ${dir}`);
    }
    console.log(`[desktop-workspace-build] building ${label}`);
    execFileSync("bun", ["run", "build"], { cwd: dir, stdio: "inherit" });
  }
}

if (import.meta.main) {
  buildDesktopWorkspaceDependencies();
}
