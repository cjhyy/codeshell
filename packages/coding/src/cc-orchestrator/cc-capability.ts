import { spawn } from "node:child_process";
import { delimiter } from "node:path";

/** Availability of one external coding CLI. */
export interface CCAvailability {
  available: boolean;
  command: string;
  version?: string;
  reason?: "not-found" | "not-executable";
}

/** macOS GUI-launched Electron has a minimal PATH (no Homebrew). Prepend common
 *  CLI dirs so `claude` resolves. Mirrors resident-agent.ts's fix. */
export function pathWithCommonBins(env: NodeJS.ProcessEnv = process.env): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const merged: string[] = [];
  for (const dir of [...extra, ...current]) if (!merged.includes(dir)) merged.push(dir);
  return merged.join(delimiter);
}

export type ProbeRunner = (command: string) => Promise<{ ok: boolean; stdout: string }>;

/** Default runner: `<command> --version` with PATH fix. */
const defaultRunner: ProbeRunner = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, ["--version"], {
      env: { ...process.env, PATH: pathWithCommonBins() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (c) => (stdout += String(c)));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ ok: code === 0, stdout }));
  });

/** Probe a CLI's availability. Injectable runner for tests. */
export async function probeCli(
  command: string,
  runner: ProbeRunner = defaultRunner,
): Promise<CCAvailability> {
  try {
    const { ok, stdout } = await runner(command);
    if (!ok) return { available: false, command, reason: "not-executable" };
    return { available: true, command, version: stdout.trim() || undefined };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      available: false,
      command,
      reason: code === "ENOENT" ? "not-found" : "not-executable",
    };
  }
}

let cached: CCAvailability | undefined;
/** Cached probe; pass force=true to re-detect (user installed CLI mid-session). */
export async function probeClaudeCli(force = false): Promise<CCAvailability> {
  if (cached && !force) return cached;
  cached = await probeCli("claude");
  return cached;
}

let cachedCodex: CCAvailability | undefined;
/** Cached probe for the OpenAI Codex CLI; force=true re-detects. */
export async function probeCodexCli(force = false): Promise<CCAvailability> {
  if (cachedCodex && !force) return cachedCodex;
  cachedCodex = await probeCli("codex");
  return cachedCodex;
}
