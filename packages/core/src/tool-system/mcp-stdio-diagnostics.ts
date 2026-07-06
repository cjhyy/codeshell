import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

const COMMON_POSIX_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  "/usr/bin",
  "/bin",
];

function unique(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function commonExecutableDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim();
  return unique([
    ...COMMON_POSIX_BIN_DIRS,
    ...(home
      ? [join(home, ".bun", "bin"), join(home, ".local", "bin"), join(home, ".npm-global", "bin")]
      : []),
  ]);
}

export function isBareCommand(command: string): boolean {
  const trimmed = command.trim();
  return !!trimmed && !trimmed.includes("/") && !trimmed.includes("\\") && !isAbsolute(trimmed);
}

export function isMissingCommandError(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown };
  const message = typeof err.message === "string" ? err.message : String(error);
  return err.code === "ENOENT" || /\bENOENT\b/i.test(message) || /command not found/i.test(message);
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function probeCommonExecutableLocations(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (!isBareCommand(command) || process.platform === "win32") return [];

  const found: string[] = [];
  for (const dir of commonExecutableDirs(env)) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) found.push(candidate);
  }
  return found;
}

function installGuidance(command: string): string {
  if (command === "node" || command === "npx")
    return "Please install Node.js and restart CodeShell.";
  if (command === "bun" || command === "bunx") return "Please install Bun and restart CodeShell.";
  return `Please install "${command}" and restart CodeShell.`;
}

export function classifyMcpStdioMissingCommand(
  command: string,
  foundPaths: readonly string[],
): string {
  const trimmed = command.trim();
  if (foundPaths.length > 0) {
    return [
      `MCP stdio command "${trimmed}" failed to start: detected ${trimmed} at ${foundPaths[0]},`,
      "but that directory was not available on PATH.",
      "Login-shell PATH injection may have failed; restart CodeShell or configure this MCP command as an absolute path.",
    ].join(" ");
  }
  return [
    `MCP stdio command "${trimmed}" failed to start: ${trimmed} was not found on PATH or in common install locations.`,
    installGuidance(trimmed),
  ].join(" ");
}

export async function diagnoseMcpStdioMissingCommand(
  command: string,
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ message: string; foundPaths: string[] } | null> {
  if (!isBareCommand(command) || !isMissingCommandError(error)) return null;
  const foundPaths = await probeCommonExecutableLocations(command, env);
  return {
    message: classifyMcpStdioMissingCommand(command, foundPaths),
    foundPaths,
  };
}

export function previewPath(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PATH ?? "").split(delimiter).filter(Boolean).join(delimiter);
}
