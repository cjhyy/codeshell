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

const PROBE_TIMEOUT_MS = 3_000;
const MAX_PROBE_STDOUT_BYTES = 16 * 1024;

/** Bounded `<command> --version` runner. Process injection keeps tests isolated
 *  from installed user CLIs; concurrent probes share only the current attempt. */
export function createProbeRunner(
  options: { timeoutMs?: number; spawn?: typeof spawn } = {},
): ProbeRunner {
  const spawnProcess = options.spawn ?? spawn;
  const inFlight = new Map<string, ReturnType<ProbeRunner>>();
  return (command) => {
    const existing = inFlight.get(command);
    if (existing) return existing;
    const pending = new Promise<{ ok: boolean; stdout: string }>((resolve, reject) => {
      const child = spawnProcess(command, ["--version"], {
        env: { ...process.env, PATH: pathWithCommonBins() },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;
      const onData = (chunk: Buffer | string) => {
        const remaining = MAX_PROBE_STDOUT_BYTES - stdoutBytes;
        if (remaining <= 0) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        // Copy the retained prefix so a large chunk cannot stay alive via a view.
        const retained = Buffer.from(bytes.subarray(0, remaining));
        chunks.push(retained);
        stdoutBytes += retained.length;
      };
      const finish = (ok: boolean, error?: Error, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.stdout?.removeListener("data", onData);
        if (terminate) {
          // A hung version check must not hold the availability request or host
          // open, even if the process never emits exit/close after termination.
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may already have exited between the timer and kill.
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        }
        if (error) reject(error);
        else resolve({ ok, stdout: Buffer.concat(chunks).toString("utf8") });
      };
      const timeout = setTimeout(
        () => finish(false, undefined, true),
        options.timeoutMs ?? PROBE_TIMEOUT_MS,
      );
      child.stdout?.on("data", onData);
      // Version checks can write diagnostics before returning. Always consume
      // stderr so a full pipe cannot prevent an otherwise healthy CLI exiting.
      child.stderr?.resume();
      // Keep the error listener after timeout to consume late process errors.
      child.on("error", (error) => finish(false, error, true));
      child.on("close", (code) => finish(code === 0));
    }).finally(() => {
      inFlight.delete(command);
    });
    inFlight.set(command, pending);
    return pending;
  };
}

const defaultRunner = createProbeRunner();

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
