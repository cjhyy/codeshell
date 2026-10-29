import { randomUUID } from "node:crypto";
import type { WorkerBridgeCore } from "@cjhyy/code-shell-server/worker";

export interface StartupArchiveMarker {
  sessionId: string;
  summary: string;
  toClientMessageId: string;
  segmentId: string;
}

/** Host-owned disk maintenance may wake the worker without starting a model turn. */
export async function requestStartupArchiveMarker(
  worker: Pick<WorkerBridgeCore, "request">,
  marker: StartupArchiveMarker,
  mainRoot: string | undefined,
  timeoutMs = 120_000,
): Promise<boolean> {
  if (!mainRoot) throw new Error("Archive marker Session root is unavailable");
  const outcome = await worker.request(
    "agent/query",
    {
      type: "archive_marker",
      sessionId: marker.sessionId,
      summary: marker.summary,
      toClientMessageId: marker.toClientMessageId,
      segmentId: marker.segmentId,
    },
    {
      id: `desktop-startup-archive-${randomUUID()}`,
      timeoutMs,
      consume: true,
      settleOnExit: true,
      failFast: true,
      ensureWorker: true,
      ensureWorkerCwd: mainRoot,
      meta: { origin: "host", producer: "pet-context-migration" },
    },
  );
  if (outcome.status === "error")
    throw new Error(outcome.error.message ?? "Archive marker request failed");
  if (outcome.status !== "result") throw new Error(`Archive marker worker ${outcome.status}`);
  const result = outcome.result as { type?: unknown; data?: { appended?: unknown } } | null;
  if (result?.type !== "archive_marker" || typeof result.data?.appended !== "boolean")
    throw new Error("Archive marker worker returned an invalid result");
  return result.data.appended;
}
