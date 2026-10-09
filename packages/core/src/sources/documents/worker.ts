import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENT_PARSE_TIMEOUT_MS, MAX_DOCUMENT_BYTES, type ParsedDocument } from "./types.js";

/** Private Host diagnostics; never included in document content or tool results. */
export interface ParserProcessReceipt {
  pid?: number;
  ppid: number;
  executable: string;
  home: string;
  runtime?: {
    pid: number;
    ppid: number;
    executable: string;
    home: string;
    cwd: string;
    environment: Record<string, string>;
    directoryModes: Record<string, number>;
    networkProbesBeforeImport: number;
    node: string;
    bun?: string;
    electron?: string;
  };
  code: number | null;
  signal: string | null;
  outcome: "success" | "failed" | "cancelled" | "timeout" | "spawn-error";
  cleanedUp: boolean;
}

function createParserEnvironment() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-document-parser-")));
  const environment: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "runtime"),
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    CODE_SHELL_HOME: join(home, "host-state"),
    TMPDIR: join(home, "tmp"),
    TEMP: join(home, "tmp"),
    TMP: join(home, "tmp"),
  };
  try {
    for (const directory of new Set(Object.values(environment)))
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    return { home, environment };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

let activeParsers = 0;
const pendingParsers: (() => void)[] = [];
async function acquireParserSlot(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (activeParsers >= 2) {
    if (pendingParsers.length >= 16)
      throw new Error("Document parser is busy; retry after current reads finish");
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = pendingParsers.indexOf(ready);
        if (index >= 0) pendingParsers.splice(index, 1);
        reject(signal?.reason ?? new Error("Document parsing was cancelled"));
      };
      pendingParsers.push(ready);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } else activeParsers++;
  return () => {
    const next = pendingParsers.shift();
    if (next) next();
    else activeParsers--;
  };
}

async function resolveParserExecutable(
  resolver: (signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        controller.abort(error);
        reject(error);
      } else resolve(value!);
    };
    const abort = () => finish(signal?.reason ?? new Error("Document parsing was cancelled"));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Document parser runtime resolution exceeded its time limit; reinstall the Host runtime or export UTF-8 text",
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return resolver(controller.signal);
      })
      .then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
  });
}

/** A terminable child keeps parser CPU/native libraries outside the Host. */
export async function parseDocumentIsolated(
  bytes: Uint8Array,
  filename: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Trusted Host only; used for PDF, never sourced from tool arguments/settings. */
    resolveExecutable?: (signal?: AbortSignal) => Promise<string>;
    /** Trusted private diagnostics, called after actual close and owned-directory cleanup. */
    onProcessExit?: (receipt: ParserProcessReceipt) => void;
  } = {},
): Promise<ParsedDocument> {
  options.signal?.throwIfAborted();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("Uploaded document exceeds the 20 MiB parsing limit");
  const release = await acquireParserSlot(options.signal);
  try {
    options.signal?.throwIfAborted();
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    let entry = fileURLToPath(new URL(`./parser-entry${extension}`, import.meta.url));
    const managedExecutable =
      /\.pdf$/i.test(filename) && options.resolveExecutable
        ? await resolveParserExecutable(
            options.resolveExecutable,
            options.signal,
            options.timeoutMs ?? DOCUMENT_PARSE_TIMEOUT_MS,
          )
        : undefined;
    options.signal?.throwIfAborted();
    if (
      managedExecutable !== undefined &&
      (!isAbsolute(managedExecutable) || managedExecutable.includes("\0"))
    )
      throw new Error("The trusted document parser executable must be an absolute path");
    // External Node has no Electron ASAR filesystem. Only the reviewed parser
    // entry/dependency closure is unpacked alongside the application archive.
    if (managedExecutable)
      entry = entry.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    const args =
      !managedExecutable && process.versions.bun
        ? ["--smol", entry]
        : ["--max-old-space-size=192", entry];
    const executable = managedExecutable ?? process.execPath;
    const { home, environment } = createParserEnvironment();
    let child: ReturnType<typeof spawn>;
    try {
      options.signal?.throwIfAborted();
      child = spawn(executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        cwd: home,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ...environment,
          ...(!managedExecutable && process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      });
    } catch (error) {
      rmSync(home, { recursive: true, force: true });
      throw error;
    }
    const receipt: ParserProcessReceipt = {
      pid: child.pid,
      ppid: process.pid,
      executable,
      home,
      code: null,
      signal: null,
      outcome: "failed",
      cleanedUp: false,
    };
    const closed = new Promise<void>((resolve) =>
      child.once("close", (code, signal) => {
        receipt.code = code;
        receipt.signal = signal;
        resolve();
      }),
    );
    try {
      return await new Promise<ParsedDocument>((resolve, reject) => {
        let settled = false;
        let size = 0;
        const output: Buffer[] = [];
        const header: Buffer[] = [];
        let headerBytes = 0;
        const finish = (error: unknown, value?: ParsedDocument) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          if (error) {
            child.kill("SIGKILL");
            reject(error);
          } else {
            receipt.outcome = "success";
            resolve(value!);
          }
        };
        const onAbort = () => {
          receipt.outcome = "cancelled";
          finish(options.signal?.reason ?? new Error("Document parsing was cancelled"));
        };
        const timer = setTimeout(() => {
          receipt.outcome = "timeout";
          finish(
            new Error(
              "Document parsing exceeded its time limit; use a smaller file or export UTF-8 text",
            ),
          );
        }, options.timeoutMs ?? DOCUMENT_PARSE_TIMEOUT_MS);
        child.once("error", (error) => {
          receipt.outcome = "spawn-error";
          finish(error);
        });
        child.stdin!.on("error", (error) => {
          if (!settled) finish(error);
        });
        child.stdout!.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > 8 * 1024 * 1024)
            finish(new Error("Document parser response exceeds its size limit"));
          else if (receipt.runtime) output.push(chunk);
          else {
            const end = chunk.indexOf(10);
            const part = end < 0 ? chunk : chunk.subarray(0, end);
            headerBytes += part.length;
            if (headerBytes > 64 * 1024) {
              finish(new Error("Document parser runtime receipt exceeds its size limit"));
              return;
            }
            header.push(part);
            if (end >= 0) {
              try {
                const runtime = JSON.parse(Buffer.concat(header).toString("utf8")).runtime;
                if (
                  !runtime ||
                  runtime.pid !== child.pid ||
                  runtime.ppid !== process.pid ||
                  runtime.home !== home ||
                  runtime.cwd !== home ||
                  realpathSync(runtime.executable) !== realpathSync(executable) ||
                  runtime.networkProbesBeforeImport !== 17 ||
                  Object.entries(environment).some(
                    ([key, value]) =>
                      runtime.environment?.[key] !== value ||
                      (process.platform !== "win32" &&
                        (runtime.directoryModes?.[key] & 0o777) !== 0o700),
                  )
                )
                  throw new Error("Document parser returned an invalid runtime receipt");
                receipt.runtime = runtime;
                header.length = 0;
                output.push(chunk.subarray(end + 1));
              } catch (error) {
                finish(error);
              }
            }
          }
        });
        child.stderr!.on("data", () => undefined);
        child.once("close", (code) => {
          if (settled) return;
          try {
            if (code !== 0)
              throw new Error(
                "Document parser exited unexpectedly; try a smaller file or export UTF-8 text",
              );
            if (!receipt.runtime)
              throw new Error("Document parser did not verify its private runtime");
            const message = JSON.parse(Buffer.concat(output).toString("utf8"));
            if (message.error) throw new Error(message.error);
            if (!message.result) throw new Error("Document parser returned an invalid result");
            finish(undefined, message.result);
          } catch (error) {
            finish(error);
          }
        });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        if (!settled)
          child.stdin!.end(
            JSON.stringify({ filename, bytes: Buffer.from(bytes).toString("base64") }),
          );
      });
    } finally {
      child.kill("SIGKILL");
      await closed;
      rmSync(home, { recursive: true, force: true });
      receipt.cleanedUp = true;
      options.onProcessExit?.(receipt);
    }
  } finally {
    release();
  }
}
