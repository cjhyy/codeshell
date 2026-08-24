import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, delimiter, extname, join } from "node:path";
import { killProcessGroup } from "@cjhyy/code-shell-core/extension";

const EXECUTABLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_LENGTH = 8_192;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_CONCURRENT_PROCESSES = 3;
const MAX_EVENT_CHARS = 16_384;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROCESS_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export interface PanelProcessOwner {
  guestId: number;
  appId: string;
  appTitle: string;
  revision: string;
  send(event: "process.output" | "process.exit", payload: Record<string, unknown>): void;
}

interface ExecutableGrant {
  guestId: number;
  name: string;
  path: string;
}

interface DirectoryGrant {
  guestId: number;
  path: string;
}

interface RunningProcess {
  guestId: number;
  child: ChildProcess;
  lifetime: ReturnType<typeof setTimeout>;
  outputBytes: number;
  outputTruncated: boolean;
}

export interface PanelAppProcessServiceOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Host-owned executable directories (for example CodeShell's managed bin). */
  extraPathDirectories?: () => readonly string[];
  confirmExecution(input: {
    guestId: number;
    appId: string;
    appTitle: string;
    executable: string;
    executablePath: string;
  }): Promise<boolean>;
}

export function panelProcessInfo(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  report: unknown = process.report?.getReport(),
): { platform: NodeJS.Platform; arch: string; libc?: "glibc" | "musl" } {
  if (platform !== "linux") return { platform, arch };
  const header =
    report && typeof report === "object"
      ? (report as { header?: { glibcVersionRuntime?: unknown } }).header
      : undefined;
  const libc =
    typeof header?.glibcVersionRuntime === "string" && header.glibcVersionRuntime
      ? "glibc"
      : "musl";
  return { platform, arch, libc };
}

export function panelExecutableDirectories(
  managedBin: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const directories = [managedBin];
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA || (options.home ? join(options.home, "AppData", "Local") : "");
    if (localAppData) {
      directories.push(
        join(localAppData, "Microsoft", "WinGet", "Links"),
        join(localAppData, "Microsoft", "WindowsApps"),
      );
    }
  }
  return [...new Set(directories.filter(Boolean))];
}

function safeProcessEnv(
  source: NodeJS.ProcessEnv,
  extraPathDirectories: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "WINDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  const safe = Object.fromEntries(
    allowed.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
  const currentPath = safe.PATH ?? "";
  safe.PATH = [...extraPathDirectories.filter(Boolean), currentPath]
    .filter(Boolean)
    .join(delimiter);
  return safe;
}

function executableCandidates(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  if (platform !== "win32" || extname(name)) return [name];
  const pathExt = env.PATHEXT || ".EXE;.CMD;.BAT;.COM";
  return pathExt
    .split(";")
    .filter(Boolean)
    .map((extension) => `${name}${extension.toLowerCase()}`);
}

export async function resolvePanelExecutable(
  name: string,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    extraPathDirectories?: readonly string[];
  } = {},
): Promise<string | null> {
  if (!EXECUTABLE_NAME.test(name)) throw new Error("invalid executable name");
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathValue = env.PATH || "";
  const directories = [
    ...(options.extraPathDirectories ?? []),
    ...pathValue.split(delimiter).filter(Boolean),
  ];
  for (const directory of [...new Set(directories)]) {
    for (const candidateName of executableCandidates(name, platform, env)) {
      const candidate = join(directory, candidateName);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        const info = await stat(candidate);
        if (info.isFile()) return await realpath(candidate);
      } catch {
        // Keep searching the remaining PATH entries.
      }
    }
  }
  return null;
}

function validateArguments(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_ARGUMENTS) {
    throw new Error(`process.spawn accepts at most ${MAX_ARGUMENTS} arguments`);
  }
  const args = raw.map((value) => {
    if (typeof value !== "string" || value.length > MAX_ARGUMENT_LENGTH || value.includes("\0")) {
      throw new Error("process.spawn arguments must be bounded strings without NUL bytes");
    }
    return value;
  });
  if (Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_ARGUMENT_BYTES) {
    throw new Error("process.spawn arguments are too large");
  }
  return args;
}

export class PanelAppProcessService {
  private readonly executables = new Map<string, ExecutableGrant>();
  private readonly directories = new Map<string, DirectoryGrant>();
  private readonly processes = new Map<string, RunningProcess>();
  private readonly approvedExecutables = new Set<string>();

  constructor(private readonly options: PanelAppProcessServiceOptions) {}

  async findExecutable(
    owner: PanelProcessOwner,
    params: unknown,
  ): Promise<{ available: boolean; name: string; handle?: string }> {
    const name = (params as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !EXECUTABLE_NAME.test(name)) {
      throw new Error("process.find requires a simple executable name");
    }
    const path = await resolvePanelExecutable(name, {
      ...this.options,
      extraPathDirectories: this.options.extraPathDirectories?.(),
    });
    if (!path) return { available: false, name };
    const handle = randomUUID();
    this.executables.set(handle, { guestId: owner.guestId, name, path });
    return { available: true, name, handle };
  }

  async grantDirectory(
    owner: PanelProcessOwner,
    path: string,
  ): Promise<{ handle: string; path: string; name: string }> {
    const resolved = await realpath(path);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error("selected process directory is not a directory");
    const handle = randomUUID();
    this.directories.set(handle, { guestId: owner.guestId, path: resolved });
    return { handle, path: resolved, name: basename(resolved) || resolved };
  }

  directoryPath(owner: PanelProcessOwner, handle: unknown): string {
    if (typeof handle !== "string") throw new Error("directory handle is required");
    const grant = this.directories.get(handle);
    if (!grant || grant.guestId !== owner.guestId) {
      throw new Error("directory handle is invalid or belongs to another Panel App");
    }
    return grant.path;
  }

  async start(
    owner: PanelProcessOwner,
    params: unknown,
  ): Promise<{ processId: string; executable: string }> {
    const input = params as {
      executableHandle?: unknown;
      directoryHandle?: unknown;
      args?: unknown;
    } | null;
    if (!input || typeof input.executableHandle !== "string") {
      throw new Error("process.spawn requires an executable handle from process.find");
    }
    const executable = this.executables.get(input.executableHandle);
    if (!executable || executable.guestId !== owner.guestId) {
      throw new Error("executable handle is invalid or belongs to another Panel App");
    }
    const cwd = this.directoryPath(owner, input.directoryHandle);
    const args = validateArguments(input.args);
    const active = [...this.processes.values()].filter(
      (process) => process.guestId === owner.guestId,
    ).length;
    if (active >= MAX_CONCURRENT_PROCESSES) {
      throw new Error(`Panel App may run at most ${MAX_CONCURRENT_PROCESSES} processes at once`);
    }

    const approvalKey = `${owner.appId}\0${owner.revision}\0${executable.path}`;
    if (!this.approvedExecutables.has(approvalKey)) {
      const allowed = await this.options.confirmExecution({
        guestId: owner.guestId,
        appId: owner.appId,
        appTitle: owner.appTitle,
        executable: executable.name,
        executablePath: executable.path,
      });
      if (!allowed) throw new Error(`User denied running ${executable.name}`);
      this.approvedExecutables.add(approvalKey);
    }

    const processId = randomUUID();
    const child = spawn(executable.path, args, {
      cwd,
      detached: process.platform !== "win32",
      env: safeProcessEnv(
        this.options.env ?? process.env,
        this.options.extraPathDirectories?.() ?? [],
      ),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const sendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const running = this.processes.get(processId);
      if (running?.child !== child || running.outputTruncated) return;
      const text = String(chunk);
      running.outputBytes += Buffer.byteLength(text, "utf8");
      if (running.outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        running.outputTruncated = true;
        owner.send("process.output", {
          processId,
          stream: "stderr",
          text: `Process output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes; CodeShell stopped it.\n`,
        });
        this.terminate(running);
        return;
      }
      for (let offset = 0; offset < text.length; offset += MAX_EVENT_CHARS) {
        owner.send("process.output", {
          processId,
          stream,
          text: text.slice(offset, offset + MAX_EVENT_CHARS),
        });
      }
    };
    child.stdout?.on("data", (chunk) => sendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => sendOutput("stderr", chunk));
    child.once("error", (error) => {
      if (this.processes.get(processId)?.child !== child) return;
      owner.send("process.output", {
        processId,
        stream: "stderr",
        text: `${error.message}\n`,
      });
    });
    const lifetime = setTimeout(() => {
      const running = this.processes.get(processId);
      if (running) this.terminate(running);
    }, PROCESS_LIFETIME_MS);
    lifetime.unref();
    this.processes.set(processId, {
      guestId: owner.guestId,
      child,
      lifetime,
      outputBytes: 0,
      outputTruncated: false,
    });
    child.once("close", (code, signal) => {
      clearTimeout(lifetime);
      if (this.processes.get(processId)?.child !== child) return;
      this.processes.delete(processId);
      owner.send("process.exit", { processId, code, signal });
    });
    return { processId, executable: executable.name };
  }

  cancel(owner: PanelProcessOwner, params: unknown): { cancelled: boolean } {
    const processId = (params as { processId?: unknown } | null)?.processId;
    if (typeof processId !== "string") throw new Error("process.cancel requires processId");
    const running = this.processes.get(processId);
    if (!running || running.guestId !== owner.guestId) return { cancelled: false };
    this.terminate(running);
    return { cancelled: true };
  }

  revokeGuest(guestId: number): void {
    for (const [handle, grant] of this.executables) {
      if (grant.guestId === guestId) this.executables.delete(handle);
    }
    for (const [handle, grant] of this.directories) {
      if (grant.guestId === guestId) this.directories.delete(handle);
    }
    for (const [processId, running] of this.processes) {
      if (running.guestId !== guestId) continue;
      clearTimeout(running.lifetime);
      this.terminate(running);
      this.processes.delete(processId);
    }
  }

  private terminate(running: RunningProcess): void {
    const pid = running.child.pid;
    if (typeof pid === "number" && pid > 1) {
      void killProcessGroup(pid);
      return;
    }
    try {
      running.child.kill("SIGTERM");
    } catch {
      // The process already exited.
    }
  }
}
