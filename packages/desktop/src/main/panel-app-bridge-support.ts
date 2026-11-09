/**
 * Bridge-wide limits and small pure helpers shared by panel-app-bridge.ts and
 * its extracted handler modules. Keeping the numbers in one place means the
 * per-method size/time budgets in `PanelAppBridge.call` and the handlers that
 * enforce the same limits cannot drift apart.
 */
import { createHash } from "node:crypto";
import { PanelBridgeError } from "@cjhyy/code-shell-server/panels";

export const MAX_PARAMS_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_CALLS_PER_WINDOW = 30;
export const RATE_WINDOW_MS = 10_000;
export const CALL_TIMEOUT_MS = 15_000;
export const RESOURCE_TRANSFER_TIMEOUT_MS = 30 * 60 * 1_000;
export const RESOURCE_TRANSFER_METHODS = new Set([
  "resources.capture",
  "resources.materialize",
  "resources.upload.finish",
  "resources.references.pick",
]);
export const PDF_EXPORT_TIMEOUT_MS = 30_000;
export const AUDIO_TRANSCRIBE_TIMEOUT_MS = 180_000;
export const COOKIE_LOGIN_TIMEOUT_MS = 30 * 60 * 1_000;
export const PROCESS_CONSENT_TIMEOUT_MS = 30 * 60 * 1_000;
export const PANEL_AGENT_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAX_AGENT_PROMPT_CHARS = 20_000;
export const MAX_NOTIFICATIONS_PER_WINDOW = 5;
export const MAX_WORKSPACE_READ_BYTES = 480 * 1024;
export const MAX_WORKSPACE_WRITE_BYTES = 384 * 1024;
export const MAX_WORKSPACE_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_WORKSPACE_LIST_ENTRIES = 200;
export const MAX_WORKSPACE_LIST_RESULT_BYTES = 512 * 1024;
export const MAX_AUDIO_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARS = 20_000;
export const AGENT_TOOL_GUEST_WAIT_MS = 4_000;
export const PANEL_GUEST_SCOPE_WAIT_MS = 4_000;
export const AUDIO_MIME_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
]);
export const WORKSPACE_TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".html",
  ".json",
  ".md",
  ".svg",
  ".tsv",
  ".txt",
  ".yaml",
  ".yml",
]);
export const DENIED_WORKSPACE_SEGMENTS = new Set(["node_modules"]);

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf-8");
}

export function workspaceRevision(content: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new PanelBridgeError("TIMEOUT", "Panel App call timed out"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
