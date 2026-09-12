import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, delimiter, extname, join } from "node:path";
import { killProcessGroup } from "@cjhyy/code-shell-core/extension";
import { verifyProcessEntry } from "./process-entry.js";
import {
  appendProcessEvent,
  ProcessReceipts,
  processLimits,
  sameProcessOwner,
  type ProcessRecord,
} from "./process-state.js";

export { processLimits } from "./process-state.js";

export interface PanelProcessApprovalScope {
  appId: string;
  revision: string;
  executablePath: string;
  executableFingerprint: string;
}

const EXECUTABLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;
const FILE_ARGUMENT_NAME = /^--[a-zA-Z][a-zA-Z0-9-]{0,63}$/;
const MAX_ARGUMENTS = processLimits.maxArguments;
const MAX_ARGUMENT_LENGTH = processLimits.maxArgumentLength;
const MAX_ARGUMENT_BYTES = processLimits.maxArgumentBytes;
const MAX_CONCURRENT_PROCESSES = processLimits.maxConcurrentProcesses;
const MAX_FILE_ARGUMENTS = processLimits.maxFileArguments;
const MAX_EVENT_CHARS = processLimits.maxEventChars;
const MAX_PROCESS_OUTPUT_BYTES = processLimits.maxOutputBytes;
const PROCESS_LIFETIME_MS = processLimits.maxLifetimeMs;

export interface PanelProcessOwner {
  guestId: number;
  appId: string;
  appTitle: string;
  revision: string;
  send(event: "process.output" | "process.exit", payload: Record<string, unknown>): void;
}

interface OwnedGrant {
  guestId: number;
  appId: string;
  revision: string;
}

interface ExecutableGrant extends OwnedGrant {
  name: string;
  path: string;
}

interface DirectoryGrant extends OwnedGrant {
  path: string;
  dev: number;
  ino: number;
}

interface FileArgumentGrant extends OwnedGrant {
  executablePath: string;
  argumentName: string;
  path: string;
  directoryHandle?: string;
  cleanup: () => void;
}

interface EntryGrant extends OwnedGrant {
  name: string;
  executableHandle: string;
  executablePath: string;
  executableFingerprint: string;
  path: string;
  sha256: string;
  identity: string;
}

interface RunningProcess {
  guestId: number;
  child: ChildProcess;
  lifetime: ReturnType<typeof setTimeout>;
  outputBytes: number;
  outputTruncated: boolean;
  record: ProcessRecord;
  stdinBytes: number;
  stdinPendingBytes: number;
  stdinPendingWrites: number;
  stdinEnded: boolean;
  stdinTail: Promise<void>;
  termination?: Promise<void>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface PanelAppProcessServiceOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Host-owned executable directories (for example CodeShell's managed bin). */
  extraPathDirectories?: () => readonly string[];
  /** Rechecked after asynchronous work and immediately before admitting a process. */
  isOwnerAuthorized?(owner: PanelProcessOwner): boolean | Promise<boolean>;
  /**
   * Desktop defaults to app-version approvals. Web uses guest to isolate each
   * authenticated instance; guest approvals never use the app-wide durable hooks.
   */
  approvalScope?: "app" | "guest";
  confirmExecution(input: {
    guestId: number;
    appId: string;
    appTitle: string;
    executable: string;
    executablePath: string;
  }): Promise<boolean>;
  isExecutionApproved?(scope: PanelProcessApprovalScope): Promise<boolean>;
  rememberExecutionApproval?(scope: PanelProcessApprovalScope): Promise<void>;
  /** Resolve a declared entry in this app revision; return a canonical, reviewed file. */
  resolvePackageEntry?(
    owner: PanelProcessOwner,
    name: string,
  ): Promise<{ path: string; sha256: string }>;
  /** Clock injection for bounded receipt retention; does not alter process deadlines. */
  now?: () => number;
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

async function executableFingerprint(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("resolved executable is no longer a regular file");
  return createHash("sha256")
    .update(String(info.dev))
    .update("\0")
    .update(String(info.ino))
    .update("\0")
    .update(String(info.size))
    .update("\0")
    .update(String(info.mtimeMs))
    .update("\0")
    .update(String(info.mode))
    .digest("hex");
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
  if (platform === "darwin") {
    if (options.home) directories.push(join(options.home, ".local", "bin"));
    directories.push("/opt/homebrew/bin", "/usr/local/bin");
  } else if (platform === "linux") {
    if (options.home) directories.push(join(options.home, ".local", "bin"));
    directories.push("/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin");
  } else if (platform === "win32") {
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
  safe.PATH = [
    ...new Set([
      ...extraPathDirectories.filter(Boolean),
      ...currentPath.split(delimiter).filter(Boolean),
    ]),
  ].join(delimiter);
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

function validateFileArgumentHandles(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_FILE_ARGUMENTS) {
    throw new Error(`process.spawn accepts at most ${MAX_FILE_ARGUMENTS} sealed file arguments`);
  }
  const handles = raw.map((value) => {
    if (typeof value !== "string" || !value || value.length > 160) {
      throw new Error("process.spawn sealed file argument handles must be bounded strings");
    }
    return value;
  });
  if (new Set(handles).size !== handles.length) {
    throw new Error("process.spawn sealed file argument handles must be unique");
  }
  return handles;
}

export class PanelAppProcessService {
  private readonly executables = new Map<string, ExecutableGrant>();
  private readonly directories = new Map<string, DirectoryGrant>();
  private readonly fileArguments = new Map<string, FileArgumentGrant>();
  private readonly entries = new Map<string, EntryGrant>();
  private readonly processes = new Map<string, RunningProcess>();
  private readonly retiring = new Map<string, RunningProcess>();
  private readonly receipts: ProcessReceipts;
  private readonly approvedExecutables = new Set<string>();
  private readonly guestEpochs = new Map<number, number>();
  private readonly reservations = new Map<number, number>();
  private closed = false;

  constructor(private readonly options: PanelAppProcessServiceOptions) {
    this.receipts = new ProcessReceipts(options.now);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private epoch(owner: PanelProcessOwner): number {
    if (this.closed) throw new Error("Panel process service is closed");
    return this.guestEpochs.get(owner.guestId) ?? 0;
  }

  private assertLive(owner: PanelProcessOwner, epoch: number): void {
    if (this.closed || (this.guestEpochs.get(owner.guestId) ?? 0) !== epoch) {
      throw new Error("Panel App process owner is no longer authorized");
    }
  }

  private async authorize(owner: PanelProcessOwner, epoch: number): Promise<void> {
    this.assertLive(owner, epoch);
    if (this.options.isOwnerAuthorized && !(await this.options.isOwnerAuthorized(owner))) {
      throw new Error("Panel App process owner is no longer authorized");
    }
    this.assertLive(owner, epoch);
  }

  async findExecutable(
    owner: PanelProcessOwner,
    params: unknown,
  ): Promise<{ available: boolean; name: string; handle?: string }> {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    await this.authorize(owner, epoch);
    const name = (params as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !EXECUTABLE_NAME.test(name)) {
      throw new Error("process.find requires a simple executable name");
    }
    const path = await resolvePanelExecutable(name, {
      ...this.options,
      extraPathDirectories: this.options.extraPathDirectories?.(),
    });
    await this.authorize(owner, epoch);
    this.assertLive(owner, epoch);
    if (!path) return { available: false, name };
    const handle = randomUUID();
    this.executables.set(handle, {
      guestId: owner.guestId,
      appId: owner.appId,
      revision: owner.revision,
      name,
      path,
    });
    return { available: true, name, handle };
  }

  async grantDirectory(
    owner: PanelProcessOwner,
    path: string,
  ): Promise<{ handle: string; path: string; name: string }> {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    await this.authorize(owner, epoch);
    const resolved = await realpath(path);
    await this.authorize(owner, epoch);
    const info = await stat(resolved);
    await this.authorize(owner, epoch);
    this.assertLive(owner, epoch);
    if (!info.isDirectory()) throw new Error("selected process directory is not a directory");
    const handle = randomUUID();
    this.directories.set(handle, {
      guestId: owner.guestId,
      appId: owner.appId,
      revision: owner.revision,
      path: resolved,
      dev: info.dev,
      ino: info.ino,
    });
    return { handle, path: resolved, name: basename(resolved) || resolved };
  }

  executableName(owner: PanelProcessOwner, handle: unknown): string {
    this.epoch(owner);
    if (typeof handle !== "string") throw new Error("executable handle is required");
    const executable = this.executables.get(handle);
    if (!executable || !sameProcessOwner(executable, owner)) {
      throw new Error("executable handle is invalid or belongs to another Panel App");
    }
    return executable.name;
  }

  async grantFileArgument(
    owner: PanelProcessOwner,
    input: {
      executableHandle: unknown;
      argumentName: unknown;
      path: string;
      cleanup?: () => void;
    },
  ): Promise<{ handle: string }> {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    await this.authorize(owner, epoch);
    if (typeof input.executableHandle !== "string") {
      throw new Error("sealed file arguments require an executable handle");
    }
    const executable = this.executables.get(input.executableHandle);
    if (!executable || !sameProcessOwner(executable, owner)) {
      throw new Error("executable handle is invalid or belongs to another Panel App");
    }
    if (typeof input.argumentName !== "string" || !FILE_ARGUMENT_NAME.test(input.argumentName)) {
      throw new Error("sealed file arguments require a simple long-option name");
    }
    const resolved = await realpath(input.path);
    await this.authorize(owner, epoch);
    const info = await stat(resolved);
    await this.authorize(owner, epoch);
    this.assertLive(owner, epoch);
    if (!info.isFile()) throw new Error("sealed process input is not a file");
    const handle = randomUUID();
    this.fileArguments.set(handle, {
      guestId: owner.guestId,
      appId: owner.appId,
      revision: owner.revision,
      executablePath: executable.path,
      argumentName: input.argumentName,
      path: resolved,
      cleanup: input.cleanup ?? (() => undefined),
    });
    return { handle };
  }

  /** Seal an already authorized directory as a long-option argument for one executable. */
  async grantDirectoryArgument(
    owner: PanelProcessOwner,
    input: { executableHandle: unknown; argumentName: unknown; directoryHandle: unknown },
  ): Promise<{ handle: string }> {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    await this.authorize(owner, epoch);
    this.executableName(owner, input.executableHandle);
    if (typeof input.argumentName !== "string" || !FILE_ARGUMENT_NAME.test(input.argumentName))
      throw new Error("sealed directory arguments require a simple long-option name");
    const path = this.directoryPath(owner, input.directoryHandle);
    const executable = this.executables.get(input.executableHandle as string)!;
    const handle = randomUUID();
    this.fileArguments.set(handle, {
      guestId: owner.guestId,
      appId: owner.appId,
      revision: owner.revision,
      executablePath: executable.path,
      argumentName: input.argumentName,
      path,
      directoryHandle: input.directoryHandle as string,
      cleanup: () => {},
    });
    return { handle };
  }

  directoryPath(owner: PanelProcessOwner, handle: unknown): string {
    this.epoch(owner);
    if (typeof handle !== "string") throw new Error("directory handle is required");
    const grant = this.directories.get(handle);
    if (!grant || !sameProcessOwner(grant, owner)) {
      throw new Error("directory handle is invalid or belongs to another Panel App");
    }
    // Final synchronous identity check preserves the existing handle API and avoids
    // an await between validating a cwd and spawning the child into that directory.
    const current = lstatSync(grant.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== grant.dev ||
      current.ino !== grant.ino ||
      realpathSync(grant.path) !== grant.path
    )
      throw new Error("granted process directory changed; select it again");
    return grant.path;
  }

  async resolveEntry(
    owner: PanelProcessOwner,
    params: unknown,
  ): Promise<{ handle: string; name: string; sha256: string }> {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    await this.authorize(owner, epoch);
    const input = params as { name?: unknown; executableHandle?: unknown } | null;
    if (!input || typeof input.name !== "string" || !EXECUTABLE_NAME.test(input.name))
      throw new Error("process.resolveEntry requires a declared entry name");
    this.executableName(owner, input.executableHandle);
    if (!this.options.resolvePackageEntry) throw new Error("package entries are unavailable");
    const executableHandle = input.executableHandle as string;
    const executable = this.executables.get(executableHandle)!;
    const entry = await this.options.resolvePackageEntry(owner, input.name);
    await this.authorize(owner, epoch);
    const identity = await verifyProcessEntry(entry.path, entry.sha256);
    const fingerprint = await executableFingerprint(executable.path);
    await this.authorize(owner, epoch);
    if (this.executables.get(executableHandle) !== executable)
      throw new Error("Panel App process handles were revoked");
    if (
      [...this.entries.values()].filter((grant) => grant.guestId === owner.guestId).length >=
      processLimits.maxEntryHandlesPerGuest
    )
      throw new Error("too many package entry handles");
    const handle = randomUUID();
    this.entries.set(handle, {
      guestId: owner.guestId,
      appId: owner.appId,
      revision: owner.revision,
      name: input.name,
      executableHandle,
      executablePath: executable.path,
      executableFingerprint: fingerprint,
      path: entry.path,
      sha256: entry.sha256,
      identity,
    });
    return { handle, name: input.name, sha256: entry.sha256 };
  }

  async start(
    owner: PanelProcessOwner,
    params: unknown,
  ): Promise<{ processId: string; executable: string }> {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    const input = params as {
      executableHandle?: unknown;
      directoryHandle?: unknown;
      args?: unknown;
      fileArgumentHandles?: unknown;
      entryHandle?: unknown;
      stdin?: unknown;
    } | null;
    if (!input || typeof input.executableHandle !== "string") {
      throw new Error("process.spawn requires an executable handle from process.find");
    }
    const executable = this.executables.get(input.executableHandle);
    if (!executable || !sameProcessOwner(executable, owner)) {
      throw new Error("executable handle is invalid or belongs to another Panel App");
    }
    const cwd = this.directoryPath(owner, input.directoryHandle);
    if (input.stdin !== undefined && input.stdin !== "ignore" && input.stdin !== "pipe")
      throw new Error("process.spawn stdin must be ignore or pipe");
    let entry: EntryGrant | undefined;
    if (input.entryHandle !== undefined) {
      entry =
        typeof input.entryHandle === "string" ? this.entries.get(input.entryHandle) : undefined;
      if (!entry || !sameProcessOwner(entry, owner))
        throw new Error("package entry handle is invalid or belongs to another Panel App");
      if (
        entry.executableHandle !== input.executableHandle ||
        entry.executablePath !== executable.path
      )
        throw new Error("package entry is bound to a different executable");
    }
    const rawArgs = validateArguments(input.args);
    const fileArgumentHandles = validateFileArgumentHandles(input.fileArgumentHandles);
    const sealedArgs: string[] = [];
    for (const handle of fileArgumentHandles) {
      const grant = this.fileArguments.get(handle);
      if (!grant || !sameProcessOwner(grant, owner)) {
        throw new Error("sealed file argument handle is invalid or belongs to another Panel App");
      }
      if (grant.executablePath !== executable.path) {
        throw new Error("sealed file argument is bound to a different executable");
      }
      if (grant.directoryHandle && this.directoryPath(owner, grant.directoryHandle) !== grant.path)
        throw new Error("sealed directory argument was replaced");
      sealedArgs.push(grant.argumentName, grant.path);
    }
    const args = validateArguments([...(entry ? [entry.path] : []), ...sealedArgs, ...rawArgs]);
    const active = [...this.processes.values()].filter(
      (process) => process.guestId === owner.guestId,
    ).length;
    const reserved = this.reservations.get(owner.guestId) ?? 0;
    if (active + reserved >= MAX_CONCURRENT_PROCESSES) {
      throw new Error(`Panel App may run at most ${MAX_CONCURRENT_PROCESSES} processes at once`);
    }
    // Admission is reserved before the first await, including a user's approval dialog.
    this.reservations.set(owner.guestId, reserved + 1);
    try {
      await this.authorize(owner, epoch);
      const scope: PanelProcessApprovalScope = {
        appId: owner.appId,
        revision: owner.revision,
        executablePath: executable.path,
        executableFingerprint: await executableFingerprint(executable.path),
      };
      if (entry && scope.executableFingerprint !== entry.executableFingerprint)
        throw new Error("package entry executable changed; resolve the entry again");
      await this.authorize(owner, epoch);
      const guestScoped = this.options.approvalScope === "guest";
      const approvalKey =
        (guestScoped ? `${owner.guestId}\0${epoch}\0` : "") +
        `${scope.appId}\0${scope.revision}\0${scope.executablePath}\0${scope.executableFingerprint}`;
      let approved = this.approvedExecutables.has(approvalKey);
      if (!approved && !guestScoped && this.options.isExecutionApproved) {
        approved = await this.options.isExecutionApproved(scope).catch(() => false);
        await this.authorize(owner, epoch);
      }
      if (!approved) {
        const allowed = await this.options.confirmExecution({
          guestId: owner.guestId,
          appId: owner.appId,
          appTitle: owner.appTitle,
          executable: executable.name,
          executablePath: executable.path,
        });
        await this.authorize(owner, epoch);
        if (!allowed) throw new Error(`User denied running ${executable.name}`);
        if (!guestScoped) {
          await this.options.rememberExecutionApproval?.(scope).catch(() => undefined);
          await this.authorize(owner, epoch);
        }
      }
      // A binary replaced while a dialog was open must earn a new approval.
      if ((await executableFingerprint(executable.path)) !== scope.executableFingerprint) {
        throw new Error("resolved executable changed; find it and approve it again");
      }
      await this.authorize(owner, epoch);
      if (entry) {
        const current = await this.options.resolvePackageEntry!(owner, entry.name);
        if (current.path !== entry.path || current.sha256 !== entry.sha256)
          throw new Error("reviewed package entry changed; resolve it again");
        await this.authorize(owner, epoch);
        if ((await verifyProcessEntry(entry.path, entry.sha256)) !== entry.identity)
          throw new Error("reviewed package entry was replaced; resolve it again");
      }
      const env = safeProcessEnv(
        this.options.env ?? process.env,
        this.options.extraPathDirectories?.() ?? [],
      );
      this.assertLive(owner, epoch);
      if (
        this.executables.get(input.executableHandle) !== executable ||
        this.directoryPath(owner, input.directoryHandle) !== cwd ||
        (entry && this.entries.get(input.entryHandle as string) !== entry)
      ) {
        throw new Error("Panel App process handles were revoked");
      }
      for (const handle of fileArgumentHandles) {
        const grant = this.fileArguments.get(handle);
        if (!grant || !sameProcessOwner(grant, owner))
          throw new Error("sealed argument was revoked");
        if (
          grant.directoryHandle &&
          this.directoryPath(owner, grant.directoryHandle) !== grant.path
        )
          throw new Error("sealed directory argument was replaced");
      }
      this.approvedExecutables.add(approvalKey);
      const processId = randomUUID();
      const child = spawn(executable.path, args, {
        cwd,
        detached: process.platform !== "win32",
        env,
        shell: false,
        stdio: [input.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const record: ProcessRecord = {
        owner: { guestId: owner.guestId, appId: owner.appId, revision: owner.revision },
        processId,
        status: "running",
        startedAt: this.now(),
        cancelRequested: false,
        sequence: 0,
        events: [],
        eventBytes: 0,
      };
      const emit = (event: "process.output" | "process.exit", payload: Record<string, unknown>) => {
        const item = appendProcessEvent(record, event, payload);
        try {
          owner.send(event, { ...item.payload });
        } catch {
          // The owner can recover a missed event through process.get.
        }
      };
      const sendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
        const running = this.processes.get(processId);
        if (running?.child !== child || running.outputTruncated) return;
        const text = String(chunk);
        running.outputBytes += Buffer.byteLength(text, "utf8");
        if (running.outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
          running.outputTruncated = true;
          emit("process.output", {
            processId,
            stream: "stderr",
            text: `Process output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes; CodeShell stopped it.\n`,
          });
          this.terminate(running);
          return;
        }
        for (let offset = 0; offset < text.length; offset += MAX_EVENT_CHARS) {
          emit("process.output", {
            processId,
            stream,
            text: text.slice(offset, offset + MAX_EVENT_CHARS),
          });
        }
      };
      child.stdout?.setEncoding("utf8").on("data", (chunk) => sendOutput("stdout", chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk) => sendOutput("stderr", chunk));
      child.stdin?.on("error", () => {
        /* write/end report pipe errors to their caller */
      });
      child.once("error", (error) => {
        if (this.processes.get(processId)?.child !== child) return;
        emit("process.output", {
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
      let finishExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
      const running: RunningProcess = {
        guestId: owner.guestId,
        child,
        lifetime,
        outputBytes: 0,
        outputTruncated: false,
        record,
        stdinBytes: 0,
        stdinPendingBytes: 0,
        stdinPendingWrites: 0,
        stdinEnded: input.stdin !== "pipe",
        stdinTail: Promise.resolve(),
        exit: new Promise((resolve) => {
          finishExit = resolve;
        }),
      };
      this.processes.set(processId, running);
      child.once("close", (code, signal) => {
        void (async () => {
          clearTimeout(lifetime);
          // Cancellation also waits for the process group, not just its leader.
          await running.termination;
          finishExit({ code, signal });
          this.retiring.delete(processId);
          if (this.processes.get(processId)?.child !== child) return;
          this.processes.delete(processId);
          record.status = "exited";
          record.exitedAt = this.now();
          record.code = code;
          record.signal = signal;
          emit("process.exit", { processId, code, signal });
          // Keep the receipt only after the operating system reports the real close.
          if (!this.closed && (this.guestEpochs.get(owner.guestId) ?? 0) === epoch)
            this.receipts.add(record);
        })();
      });
      return { processId, executable: executable.name };
    } finally {
      const remaining = (this.reservations.get(owner.guestId) ?? 1) - 1;
      if (remaining) this.reservations.set(owner.guestId, remaining);
      else this.reservations.delete(owner.guestId);
    }
  }

  cancel(owner: PanelProcessOwner, params: unknown): { cancelled: boolean } {
    this.epoch(owner);
    const processId = (params as { processId?: unknown } | null)?.processId;
    if (typeof processId !== "string") throw new Error("process.cancel requires processId");
    const running = this.processes.get(processId);
    if (!running || !sameProcessOwner(running.record.owner, owner)) return { cancelled: false };
    this.terminate(running);
    return { cancelled: true };
  }

  /** Host-only wait captured while the owner is live; never exposes output after revocation. */
  waitForExit(owner: PanelProcessOwner, params: { processId: string }) {
    const running = this.processes.get(params.processId) ?? this.retiring.get(params.processId);
    if (running && sameProcessOwner(running.record.owner, owner)) return running.exit;
    const receipt = this.receipts.get(params.processId);
    if (receipt && sameProcessOwner(receipt.owner, owner))
      return Promise.resolve({ code: receipt.code ?? null, signal: receipt.signal ?? null });
    return Promise.reject(new Error("process is unavailable or belongs to another Panel App"));
  }

  async get(owner: PanelProcessOwner, params: unknown) {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    await this.authorize(owner, epoch);
    const input = params as {
      processId?: unknown;
      afterSequence?: unknown;
      limit?: unknown;
    } | null;
    if (typeof input?.processId !== "string" || input.processId.length > 160)
      throw new Error("process.get requires a processId");
    const after = input.afterSequence ?? 0;
    const limit = input.limit ?? 128;
    if (!Number.isSafeInteger(after) || (after as number) < 0)
      throw new Error("process.get afterSequence must be a nonnegative integer");
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 256)
      throw new Error("process.get limit must be between 1 and 256");
    const record =
      this.processes.get(input.processId)?.record ?? this.receipts.get(input.processId);
    if (!record || !sameProcessOwner(record.owner, owner))
      return { found: false as const, processId: input.processId };
    if ((after as number) > record.sequence)
      throw new Error("process.get cursor is ahead of this process");
    const events = record.events
      .filter((event) => event.sequence > (after as number))
      .slice(0, limit as number);
    const nextSequence = events.at(-1)?.sequence ?? (after as number);
    return {
      found: true as const,
      processId: record.processId,
      status: record.status,
      startedAt: record.startedAt,
      ...(record.exitedAt === undefined ? {} : { exitedAt: record.exitedAt }),
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      ...(record.code === undefined ? {} : { code: record.code }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      cancelRequested: record.cancelRequested,
      sequence: record.sequence,
      nextSequence,
      events: structuredClone(events),
      truncated: (after as number) < (record.events[0]?.sequence ?? 1) - 1,
      hasMore: nextSequence < record.sequence,
    };
  }

  private writableProcess(owner: PanelProcessOwner, processId: unknown): RunningProcess {
    if (typeof processId !== "string") throw new Error("process input requires a processId");
    const running = this.processes.get(processId);
    if (!running || !sameProcessOwner(running.record.owner, owner))
      throw new Error("process is unavailable or belongs to another Panel App");
    if (
      running.record.status !== "running" ||
      !running.child.stdin ||
      running.child.stdin.destroyed
    )
      throw new Error("process stdin is unavailable");
    return running;
  }

  async write(
    owner: PanelProcessOwner,
    params: unknown,
  ): Promise<{ bytesWritten: number; totalBytes: number }> {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    await this.authorize(owner, epoch);
    const input = params as { processId?: unknown; text?: unknown } | null;
    if (typeof input?.text !== "string") throw new Error("process.write requires UTF-8 text");
    const bytes = Buffer.byteLength(input.text);
    if (bytes > processLimits.maxStdinChunkBytes)
      throw new Error("process stdin chunk exceeds limit");
    const running = this.writableProcess(owner, input.processId);
    if (running.stdinEnded) throw new Error("process stdin has ended");
    if (running.stdinBytes + bytes > processLimits.maxStdinBytes)
      throw new Error("process stdin total exceeds limit");
    if (
      running.stdinPendingBytes + bytes > processLimits.maxStdinPendingBytes ||
      running.stdinPendingWrites >= processLimits.maxStdinPendingWrites
    )
      throw new Error("process stdin is backpressured; await pending writes");
    running.stdinBytes += bytes;
    running.stdinPendingBytes += bytes;
    running.stdinPendingWrites++;
    const totalBytes = running.stdinBytes;
    const operation = running.stdinTail
      .then(async () => {
        await this.authorize(owner, epoch);
        this.writableProcess(owner, input.processId);
        await this.sendInput(running, input.text as string);
      })
      .finally(() => {
        running.stdinPendingBytes -= bytes;
        running.stdinPendingWrites--;
      });
    running.stdinTail = operation.catch(() => {
      running.stdinEnded = true;
    });
    await operation;
    return { bytesWritten: bytes, totalBytes };
  }

  async end(
    owner: PanelProcessOwner,
    params: unknown,
  ): Promise<{ ended: true; totalBytes: number }> {
    owner = { ...owner };
    const epoch = this.epoch(owner);
    await this.authorize(owner, epoch);
    const processId = (params as { processId?: unknown } | null)?.processId;
    const running = this.writableProcess(owner, processId);
    if (running.stdinEnded) throw new Error("process stdin has ended");
    running.stdinEnded = true;
    const operation = running.stdinTail.then(async () => {
      await this.authorize(owner, epoch);
      this.writableProcess(owner, processId);
      await this.sendInput(running);
    });
    running.stdinTail = operation.catch(() => {});
    await operation;
    return { ended: true, totalBytes: running.stdinBytes };
  }

  private sendInput(running: RunningProcess, text?: string): Promise<void> {
    const stream = running.child.stdin!;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.off("error", onError);
        running.child.off("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error("process exited before stdin completed"));
      const timer = setTimeout(() => {
        this.terminate(running);
        finish(new Error("process stdin write timed out"));
      }, processLimits.stdinWriteTimeoutMs);
      timer.unref();
      stream.once("error", onError);
      running.child.once("close", onClose);
      if (text === undefined) stream.end(() => finish());
      else stream.write(text, "utf8", finish);
    });
  }

  revokeGuest(guestId: number): void {
    this.guestEpochs.set(guestId, (this.guestEpochs.get(guestId) ?? 0) + 1);
    if (this.options.approvalScope === "guest") {
      for (const key of this.approvedExecutables) {
        if (key.startsWith(`${guestId}\0`)) this.approvedExecutables.delete(key);
      }
    }
    for (const [handle, grant] of this.executables) {
      if (grant.guestId === guestId) this.executables.delete(handle);
    }
    for (const [handle, grant] of this.directories) {
      if (grant.guestId === guestId) this.directories.delete(handle);
    }
    for (const [handle, grant] of this.entries) {
      if (grant.guestId === guestId) this.entries.delete(handle);
    }
    this.receipts.revokeGuest(guestId);
    for (const [processId, running] of this.processes) {
      if (running.guestId !== guestId) continue;
      clearTimeout(running.lifetime);
      this.terminate(running);
      this.retiring.set(processId, running);
      this.processes.delete(processId);
    }
    for (const [handle, grant] of this.fileArguments) {
      if (grant.guestId !== guestId) continue;
      this.fileArguments.delete(handle);
      try {
        grant.cleanup();
      } catch {
        // Credential-backed temporary inputs are best-effort cleanup only.
      }
    }
  }

  /** Permanently shut down all guests, including operations awaiting approval. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const guests = new Set([
      ...this.guestEpochs.keys(),
      ...this.reservations.keys(),
      ...[...this.executables.values()].map((grant) => grant.guestId),
      ...[...this.directories.values()].map((grant) => grant.guestId),
      ...[...this.fileArguments.values()].map((grant) => grant.guestId),
      ...[...this.entries.values()].map((grant) => grant.guestId),
      ...[...this.processes.values()].map((running) => running.guestId),
    ]);
    for (const guestId of guests) this.revokeGuest(guestId);
    this.approvedExecutables.clear();
    this.receipts.close();
  }

  private terminate(running: RunningProcess): void {
    if (running.termination) return;
    running.record.cancelRequested = true;
    running.record.status = "stopping";
    const pid = running.child.pid;
    if (typeof pid === "number" && pid > 1) {
      running.termination = killProcessGroup(pid).catch(() => {});
      return;
    }
    try {
      running.child.kill("SIGTERM");
    } catch {
      // The process already exited.
    }
  }
}
