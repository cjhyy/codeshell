/**
 * Environment detection — platform, runtime, config paths, network.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ─── Platform / Terminal ────────────────────────────────────────────

export const env = {
  platform: process.platform as "darwin" | "linux" | "win32",
  terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown",
  shell: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
  isCI: !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI),
};

export function getHostPlatform(): "macos" | "linux" | "windows" {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export function getHostPlatformForAnalytics(): string {
  return getHostPlatform();
}

export function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const release = execSync("uname -r", { encoding: "utf-8", timeout: 2000 });
    return /microsoft|wsl/i.test(release);
  } catch {
    return false;
  }
}

// ─── Config Paths ───────────────────────────────────────────────────

const HOME = homedir();

/** ~/.claude/ directory (Claude Code compatible) */
export function getGlobalClaudeDir(): string {
  return join(HOME, ".claude");
}

/** ~/.code-shell/ directory */
export function getGlobalCodeShellDir(): string {
  return join(HOME, ".code-shell");
}

/** Resolve a file in ~/.claude/ or ~/.code-shell/ (claude takes precedence) */
export function getGlobalClaudeFile(filename: string): string | undefined {
  const claudePath = join(getGlobalClaudeDir(), filename);
  if (existsSync(claudePath)) return claudePath;
  const csPath = join(getGlobalCodeShellDir(), filename);
  if (existsSync(csPath)) return csPath;
  return undefined;
}

// ─── Runtime / Package Manager ──────────────────────────────────────

export function getRuntime(): "bun" | "deno" | "node" {
  if (typeof Bun !== "undefined") return "bun";
  if (typeof (globalThis as any).Deno !== "undefined") return "deno";
  return "node";
}

export function getPackageManager(cwd?: string): "bun" | "pnpm" | "yarn" | "npm" {
  const dir = cwd ?? process.cwd();
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

// ─── Network ────────────────────────────────────────────────────────

let _hasInternet: boolean | undefined;

export async function hasInternetAccess(): Promise<boolean> {
  if (_hasInternet !== undefined) return _hasInternet;
  try {
    const { connect } = await import("node:net");
    return await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
      socket.on("connect", () => { socket.destroy(); _hasInternet = true; resolve(true); });
      socket.on("error", () => { _hasInternet = false; resolve(false); });
      socket.on("timeout", () => { socket.destroy(); _hasInternet = false; resolve(false); });
    });
  } catch {
    _hasInternet = false;
    return false;
  }
}

// ─── IDE Detection ──────────────────────────────────────────────────

export const JETBRAINS_IDES = [
  "idea", "pycharm", "webstorm", "phpstorm", "rubymine",
  "clion", "goland", "rider", "datagrip", "fleet",
] as const;

export function isJetBrainsTerminal(): boolean {
  return !!(process.env.TERMINAL_EMULATOR?.includes("JetBrains") ||
    process.env.JETBRAINS_IDE);
}

export function isVSCodeTerminal(): boolean {
  return process.env.TERM_PROGRAM === "vscode";
}
