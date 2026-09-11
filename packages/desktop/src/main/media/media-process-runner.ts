import { spawn } from "node:child_process";

export interface MediaProcessProgress {
  fraction?: number;
  stage?: string;
  message?: string;
}

export interface MediaProcessOptions {
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  durationSeconds?: number;
  progressStream?: "stdout" | "stderr";
  onProgress?: (progress: MediaProcessProgress) => void | Promise<void>;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: string) => void;
  maxStdoutBytes?: number;
}

export function mediaAbortError(): Error {
  return Object.assign(new Error("Media processing was cancelled"), { name: "AbortError" });
}

/** Execute a local media tool without a shell; cancellation also stops its children. */
export async function runMediaProcess(
  executable: string,
  args: readonly string[],
  options: MediaProcessOptions,
): Promise<{ stdout: Buffer; stderr: string }> {
  if (options.signal.aborted) throw mediaAbortError();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let progressBuffer = "";
    let lastProgress = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let progressWork = Promise.resolve();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The process may have already exited. */
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1500);
      killTimer.unref();
    };
    const cleanup = () => {
      options.signal.removeEventListener("abort", stop);
      if (killTimer) clearTimeout(killTimer);
    };
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    const consumeProgress = (text: string) => {
      if (options.durationSeconds && options.onProgress) {
        progressBuffer += text;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = (lines.pop() ?? "").slice(-4096);
        for (const line of lines) {
          const match = /^out_time_us=(\d+)$/.exec(line);
          if (!match || Date.now() - lastProgress < 150) continue;
          lastProgress = Date.now();
          const fraction = Math.min(0.999, Number(match[1]) / 1_000_000 / options.durationSeconds);
          progressWork = progressWork
            .then(async () => {
              await options.onProgress?.({ fraction });
            })
            .catch((error) => {
              failure = error instanceof Error ? error : new Error(String(error));
              stop();
            });
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        if (options.onStdout) options.onStdout(chunk);
        else {
          bytes += chunk.length;
          if (bytes > (options.maxStdoutBytes ?? 4 * 1024 * 1024)) {
            failure = new Error("Media tool output exceeds its bounded result budget");
            stop();
            return;
          }
          stdout.push(chunk);
        }
        if (options.progressStream !== "stderr") consumeProgress(chunk.toString("utf8"));
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = (stderr + text).slice(-128 * 1024);
      try {
        options.onStderr?.(text);
        if (options.progressStream === "stderr") consumeProgress(text);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", async (code) => {
      cleanup();
      try {
        await progressWork;
        if (options.signal.aborted) throw mediaAbortError();
        if (failure) throw failure;
        if (code !== 0)
          throw new Error(`${executable} exited with code ${code}: ${stderr.slice(-4000)}`);
        resolve({ stdout: Buffer.concat(stdout), stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}
