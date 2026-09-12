import { createHash } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { PanelAppProcessService, type PanelProcessOwner } from "./process-service.js";
import { processLimits } from "./process-state.js";
import { PanelResourceService } from "./resources/service.js";
import { resourceRelativePath } from "./resources/directories.js";
import { materializePanelConnections, panelConnectionIds } from "./connections.js";

interface Scope {
  appId: string;
  projectPath: string;
  revision: string;
}
interface Job {
  id: string;
  scope: Scope;
  entry: { name: string; sha256: string };
  input: unknown;
}
interface ExecutionContext {
  workDir: string;
  signal: AbortSignal;
  reportProgress(progress: { fraction?: number; stage?: string; message?: string }): Promise<void>;
}
interface ToolInput {
  request: Record<string, unknown>;
  resources?: Array<{ assetId: string; path: string }>;
  directoryArguments?: Array<{
    argumentName: string;
    directory: "job" | "app-data";
    path?: string;
  }>;
  connectionIds?: string[];
  connectionArgument?: string;
}
export interface PanelToolExecutorOptions {
  processes: PanelAppProcessService;
  resources: PanelResourceService;
  /** Registered before any grants. The Host owns lifetime, approval and immutable app identity. */
  owner(job: Job, send: PanelProcessOwner["send"]): PanelProcessOwner;
  releaseOwner(owner: PanelProcessOwner): void;
  appDataDirectory(scope: Scope): Promise<string>;
  authorize(scope: Scope): Promise<void>;
  authorizeConnections(scope: Scope): Promise<void>;
  sealedRoot: string;
}
function toolInput(value: unknown): ToolInput {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "request",
          "resources",
          "directoryArguments",
          "connectionIds",
          "connectionArgument",
        ].includes(key),
    )
  )
    throw new Error("Invalid tool job input");
  const input = value as ToolInput;
  if (!input.request || typeof input.request !== "object" || Array.isArray(input.request))
    throw new Error("Tool request must be an object");
  if (
    input.resources !== undefined &&
    (!Array.isArray(input.resources) || input.resources.length > 128)
  )
    throw new Error("Too many tool resources");
  const paths = new Set<string>();
  for (const resource of input.resources ?? []) {
    if (
      !resource ||
      Object.keys(resource).some((key) => !["assetId", "path"].includes(key)) ||
      !/^asset-[a-f0-9]{64}$/.test(resource.assetId)
    )
      throw new Error("Invalid tool resource");
    resourceRelativePath(resource.path);
    if (paths.has(resource.path)) throw new Error("Duplicate tool resource path");
    paths.add(resource.path);
  }
  if (
    input.directoryArguments !== undefined &&
    (!Array.isArray(input.directoryArguments) || input.directoryArguments.length > 4)
  )
    throw new Error("Too many tool directories");
  const argumentsSeen = new Set<string>();
  for (const item of input.directoryArguments ?? []) {
    if (
      !item ||
      !/^--[a-z][a-z0-9-]{0,63}$/.test(item.argumentName) ||
      !["job", "app-data"].includes(item.directory) ||
      Object.keys(item).some((key) => !["argumentName", "directory", "path"].includes(key))
    )
      throw new Error("Invalid tool directory argument");
    if (argumentsSeen.has(item.argumentName)) throw new Error("Duplicate tool argument");
    argumentsSeen.add(item.argumentName);
    if (item.path !== undefined) resourceRelativePath(item.path);
  }
  if (input.connectionIds !== undefined) {
    panelConnectionIds(input.connectionIds);
    if (
      !input.connectionArgument ||
      !/^--[a-z][a-z0-9-]{0,63}$/.test(input.connectionArgument) ||
      argumentsSeen.has(input.connectionArgument)
    )
      throw new Error("Invalid connection argument");
  } else if (input.connectionArgument !== undefined)
    throw new Error("Connection selection is required");
  return input;
}
async function childDirectory(root: string, relative?: string) {
  let path = await realpath(root);
  for (const part of relative ? resourceRelativePath(relative).split("/") : []) {
    path = join(path, part);
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Tool directory changed");
  }
  return path;
}
/** The only background processor: launch a reviewed tool and transport bounded JSON/files. */
export function createPanelToolExecutor(options: PanelToolExecutorOptions) {
  return {
    async prepareInput(scope: Scope, raw: unknown, workDir: string, signal: AbortSignal) {
      const input = toolInput(raw);
      await options.authorize(scope);
      const handle = createHash("sha256").update(workDir).digest("hex");
      try {
        for (const resource of input.resources ?? []) {
          await options.resources.dispatch(
            scope,
            "resources.materialize",
            { ...resource, directoryHandle: handle },
            {
              signal,
              resolveDirectory: async () => {
                await options.authorize(scope);
                return workDir;
              },
            },
          );
        }
        if (input.connectionIds) await options.authorizeConnections(scope);
        return input;
      } finally {
        options.resources.releaseDirectory(scope, handle);
      }
    },
    async execute(job: Job, context: ExecutionContext) {
      const input = toolInput(job.input);
      await options.authorize(job.scope);
      let stdout = "",
        outputBytes = 0,
        result: unknown,
        failed: Error | undefined;
      let processId = "",
        terminal = false,
        stopped: Promise<void> | undefined;
      let progress = Promise.resolve();
      let pendingProgress: Record<string, unknown> | undefined;
      let reportingProgress = false;
      let sequence = 0;
      const pendingEvents = new Map<
        number,
        { event: "process.output" | "process.exit"; payload: Record<string, unknown> }
      >();
      let reconciling: Promise<void> | undefined;
      let finish!: (value: { code: unknown; signal: unknown }) => void;
      const exit = new Promise<{ code: unknown; signal: unknown }>((resolve) => {
        finish = resolve;
      });
      const stop = () => {
        stopped ??= (async () => {
          if (!processId || terminal) return;
          await options.processes.cancel(owner, { processId });
          await exit;
        })();
        return stopped;
      };
      const parse = (line: string) => {
        if (!line.trim()) return;
        const message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw new Error("Invalid tool response");
        if (message.type === "progress") {
          if (
            !message.progress ||
            typeof message.progress !== "object" ||
            Array.isArray(message.progress)
          )
            throw new Error("Invalid tool progress");
          pendingProgress = message.progress;
          if (!reportingProgress) {
            reportingProgress = true;
            progress = (async () => {
              while (pendingProgress !== undefined) {
                const update = pendingProgress;
                pendingProgress = undefined;
                await context.reportProgress(update);
              }
            })()
              .catch((error) => {
                failed ??= error instanceof Error ? error : new Error(String(error));
                void stop();
              })
              .finally(() => {
                reportingProgress = false;
              });
          }
        } else if (message.type === "result") {
          if (result !== undefined) throw new Error("Tool returned multiple results");
          result = message.result;
        } else if (message.type === "error") {
          failed ??= Object.assign(
            new Error(
              typeof message.message === "string" ? message.message.slice(0, 2000) : "Tool failed",
            ),
            {
              ...(typeof message.code === "string" ? { code: message.code.slice(0, 100) } : {}),
              ...(typeof message.retryable === "boolean" ? { retryable: message.retryable } : {}),
            },
          );
          void stop();
        } else throw new Error("Unsupported tool response");
      };
      const consume = (
        event: "process.output" | "process.exit",
        payload: Record<string, unknown>,
      ) => {
        if (event === "process.exit") {
          terminal = true;
          finish({ code: payload.code, signal: payload.signal });
          return;
        }
        if (payload.stream !== "stdout" || typeof payload.text !== "string") return;
        try {
          outputBytes += Buffer.byteLength(payload.text);
          if (outputBytes > processLimits.maxOutputBytes)
            throw new Error("Tool output exceeds the limit");
          stdout += payload.text;
          while (stdout.includes("\n")) {
            const end = stdout.indexOf("\n");
            const line = stdout.slice(0, end);
            stdout = stdout.slice(end + 1);
            parse(line);
          }
          if (Buffer.byteLength(stdout) > 256 * 1024)
            throw new Error("Tool response exceeds the limit");
        } catch (error) {
          failed ??= error instanceof Error ? error : new Error("Invalid tool output");
          void stop();
        }
      };
      const receive = (
        event: "process.output" | "process.exit",
        payload: Record<string, unknown>,
      ) => {
        if (processId && payload.processId !== processId) return;
        if (!Number.isSafeInteger(payload.sequence)) {
          consume(event, payload);
          return;
        }
        const cursor = Number(payload.sequence);
        if (cursor <= sequence) return;
        pendingEvents.set(cursor, { event, payload });
        if (pendingEvents.size > processLimits.maxEventsPerProcess) {
          failed ??= new Error("Too many missed tool events");
          void stop();
          return;
        }
        while (pendingEvents.has(sequence + 1)) {
          const item = pendingEvents.get(++sequence)!;
          pendingEvents.delete(sequence);
          consume(item.event, item.payload);
        }
      };
      const owner = options.owner(job, receive);
      const reconcile = () => {
        if (!processId) return Promise.resolve();
        return (reconciling ??= (async () => {
          const receipt = await options.processes.get(owner, {
            processId,
            afterSequence: sequence,
            limit: 256,
          });
          if (!receipt.found) throw new Error("Tool process receipt is unavailable");
          if (receipt.truncated) throw new Error("Tool output was lost before it could be read");
          for (const item of receipt.events) receive(item.event, item.payload);
        })()
          .catch((error) => {
            failed ??= error instanceof Error ? error : new Error(String(error));
            void stop();
          })
          .finally(() => {
            reconciling = undefined;
          }));
      };
      const receiptTimer = setInterval(() => {
        void reconcile();
      }, 200);
      receiptTimer.unref();
      const abort = () => {
        void stop();
      };
      context.signal.addEventListener("abort", abort, { once: true });
      const cleanups: Array<() => void> = [];
      const resourceDirectoryHandles: string[] = [];
      let checking = false;
      const authorizationTimer = setInterval(() => {
        if (checking || terminal) return;
        checking = true;
        void options
          .authorize(job.scope)
          .catch(() => {
            failed ??= Object.assign(new Error("Tool task authorization was revoked"), {
              code: "APP_REVOKED",
              retryable: false,
            });
            return stop();
          })
          .finally(() => {
            checking = false;
          });
      }, 1000);
      authorizationTimer.unref();
      try {
        const executable = await options.processes.findExecutable(owner, { name: "node" });
        if (!executable.available || !executable.handle)
          throw new Error("Node.js 20 or newer is required for installed tools");
        const entry = await options.processes.resolveEntry(owner, {
          name: job.entry.name,
          executableHandle: executable.handle,
        });
        if (entry.sha256 !== job.entry.sha256)
          throw new Error("Installed tool changed; start a new job");
        const directory = await options.processes.grantDirectory(owner, context.workDir);
        resourceDirectoryHandles.push(directory.handle);
        const fileArgumentHandles: string[] = [];
        for (const item of input.directoryArguments ?? []) {
          const root =
            item.directory === "job" ? context.workDir : await options.appDataDirectory(job.scope);
          const location = await childDirectory(root, item.path);
          const grant = await options.processes.grantDirectory(owner, location);
          const argument = await options.processes.grantDirectoryArgument(owner, {
            executableHandle: executable.handle,
            argumentName: item.argumentName,
            directoryHandle: grant.handle,
          });
          fileArgumentHandles.push(argument.handle);
        }
        if (input.connectionIds) {
          await options.authorizeConnections(job.scope);
          const sealed = await materializePanelConnections(
            options.sealedRoot,
            job.scope.projectPath,
            input.connectionIds,
          );
          cleanups.push(sealed.cleanup);
          const argument = await options.processes.grantFileArgument(owner, {
            executableHandle: executable.handle,
            argumentName: input.connectionArgument!,
            path: sealed.path,
            cleanup: sealed.cleanup,
          });
          fileArgumentHandles.push(argument.handle);
        }
        context.signal.throwIfAborted();
        const launched = await options.processes.start(owner, {
          executableHandle: executable.handle,
          entryHandle: entry.handle,
          directoryHandle: directory.handle,
          fileArgumentHandles,
          args: [],
          stdin: "pipe",
        });
        processId = launched.processId;
        // Capture this Host-only waiter before revocation can retire the owner's grants.
        void options.processes
          .waitForExit(owner, { processId })
          .then((value) => {
            terminal = true;
            finish(value);
          })
          .catch((error) => {
            // This can only be absent after the process has already closed and its
            // owner retired the receipt before the waiter attached.
            failed ??= error instanceof Error ? error : new Error(String(error));
            terminal = true;
            finish({ code: null, signal: null });
          });
        if (failed || context.signal.aborted) {
          stopped = undefined;
          await stop();
          context.signal.throwIfAborted();
          throw failed;
        }
        const request = JSON.stringify({
          ...input.request,
          jobId: job.id,
          scopeKey: createHash("sha256")
            .update(JSON.stringify([job.scope.appId, job.scope.projectPath]))
            .digest("hex"),
        });
        if (Buffer.byteLength(request) > processLimits.maxStdinBytes)
          throw new Error("Tool input exceeds the stdin limit");
        // Slice by characters conservatively, preserving surrogate pairs across writes.
        const characters = Array.from(request);
        for (let i = 0; i < characters.length; i += 3000) {
          context.signal.throwIfAborted();
          await options.processes.write(owner, {
            processId,
            text: characters.slice(i, i + 3000).join(""),
          });
        }
        await options.processes.end(owner, { processId });
        const receipt = await exit;
        await reconciling;
        await reconcile();
        if (stdout.trim()) parse(stdout);
        await progress;
        context.signal.throwIfAborted();
        if (failed) throw failed;
        if (receipt.code !== 0 || result === undefined)
          throw new Error("Tool did not return a completed result");
        const value = result as { artifacts?: unknown };
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Tool result must be an object");
        if (value.artifacts !== undefined) {
          if (!Array.isArray(value.artifacts) || value.artifacts.length > 128)
            throw new Error("Invalid tool output inventory");
          const assets: unknown[] = [];
          for (const artifact of value.artifacts) {
            if (
              !artifact ||
              typeof artifact !== "object" ||
              !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
              artifact.assetId !== `asset-${artifact.sha256}`
            )
              throw new Error("Invalid tool artifact identity");
            resourceRelativePath(artifact.file);
            if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)
              throw new Error("Invalid tool artifact size");
            const captured = await options.resources.dispatch(
              job.scope,
              "resources.capture",
              {
                directoryHandle: directory.handle,
                path: artifact.file,
                name: artifact.name ?? artifact.file.split("/").at(-1),
                mimeType: artifact.mimeType,
                expectedBytes: artifact.bytes,
                expectedSha256: artifact.sha256,
              },
              {
                resolveDirectory: (handle) => options.processes.directoryPath(owner, handle),
                signal: context.signal,
              },
            );
            assets.push({ ...artifact, asset: captured.asset });
          }
          value.artifacts = assets;
        }
        await options.authorize(job.scope);
        return value;
      } finally {
        clearInterval(receiptTimer);
        clearInterval(authorizationTimer);
        context.signal.removeEventListener("abort", abort);
        if (processId && !terminal) {
          stopped = undefined;
          await stop().catch(() => {});
        }
        options.processes.revokeGuest(owner.guestId);
        for (const handle of resourceDirectoryHandles)
          options.resources.releaseDirectory(job.scope, handle);
        options.releaseOwner(owner);
        for (const cleanup of cleanups) cleanup();
      }
    },
  };
}
