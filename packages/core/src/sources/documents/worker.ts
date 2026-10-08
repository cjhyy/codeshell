import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DOCUMENT_PARSE_TIMEOUT_MS, MAX_DOCUMENT_BYTES, type ParsedDocument } from "./types.js";

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

/** A terminable child keeps parser CPU/native libraries outside the Host. */
export async function parseDocumentIsolated(
  bytes: Uint8Array,
  filename: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ParsedDocument> {
  options.signal?.throwIfAborted();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("Uploaded document exceeds the 20 MiB parsing limit");
  const release = await acquireParserSlot(options.signal);
  try {
    options.signal?.throwIfAborted();
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const entry = fileURLToPath(new URL(`./parser-entry${extension}`, import.meta.url));
    const args = process.versions.bun ? ["--smol", entry] : ["--max-old-space-size=192", entry];
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      return await new Promise<ParsedDocument>((resolve, reject) => {
        let settled = false;
        let size = 0;
        const output: Buffer[] = [];
        const finish = (error: unknown, value?: ParsedDocument) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          if (error) {
            child.kill("SIGKILL");
            reject(error);
          } else resolve(value!);
        };
        const onAbort = () =>
          finish(options.signal?.reason ?? new Error("Document parsing was cancelled"));
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                "Document parsing exceeded its time limit; use a smaller file or export UTF-8 text",
              ),
            ),
          options.timeoutMs ?? DOCUMENT_PARSE_TIMEOUT_MS,
        );
        child.once("error", (error) => finish(error));
        child.stdin.on("error", (error) => {
          if (!settled) finish(error);
        });
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024)
            finish(new Error("Document parser response exceeds its size limit"));
          else output.push(chunk);
        });
        child.stderr.on("data", () => undefined);
        child.once("close", (code) => {
          if (settled) return;
          try {
            if (code !== 0)
              throw new Error(
                "Document parser exited unexpectedly; try a smaller file or export UTF-8 text",
              );
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
          child.stdin.end(
            JSON.stringify({ filename, bytes: Buffer.from(bytes).toString("base64") }),
          );
      });
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  } finally {
    release();
  }
}
