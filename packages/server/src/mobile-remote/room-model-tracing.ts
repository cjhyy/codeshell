import { randomUUID } from "node:crypto";
import {
  recordExternalModelTrace,
  recordModelTraceEvent,
  withModelTraceContext,
  ModelTraceStore,
  type ModelTraceEvent,
  type ModelTraceStatus,
} from "@cjhyy/code-shell-core/internal";
import type { ResidentAgentEvent } from "./resident-agent.js";

const MAX_TEXT = 128 * 1024;
const MAX_INPUTS = 128;

/**
 * Resident Claude accepts overlapping inputs without request IDs in its output.
 * A batch preserves observed order without inventing a prompt-to-response map.
 */
export function createRoomModelTrace(options: {
  storageDir: string;
  workspacePath: string;
  roomId: string;
  kind: string;
  parameters?: Record<string, unknown>;
}) {
  const context = {
    storageDir: options.storageDir,
    workspacePath: options.workspacePath,
    sessionId: undefined,
    runId: undefined,
    parentSessionId: undefined,
    ephemeral: false,
    source: `external-room-${options.kind}`,
    purpose: "external_room_batch",
  };
  const startedAt = Date.now();
  const traceId = randomUUID();
  const store = new ModelTraceStore({ storageDir: options.storageDir });
  const policyRevision = store.getConfig().policyRevision;
  const contentEnabled = () => {
    try {
      const config = store.getConfig();
      return (
        capture &&
        config.enabled &&
        config.captureContent &&
        config.policyRevision === policyRevision
      );
    } catch {
      return false;
    }
  };
  const common = { ...context, traceId, provider: options.kind, model: "CLI default", startedAt };
  let recordId: string | undefined;
  let capture = false;
  let pending = 0;
  let batchFailed = false;
  let batchCancelled = false;
  let submissionCount = 0;
  let ended = false;
  let text = "";
  let error: string | undefined;
  const messages: unknown[] = [];
  const tools = new Map<string, ModelTraceEvent>();
  const write = (status: ModelTraceStatus, endedAt?: number) => {
    const result = recordExternalModelTrace({
      ...common,
      id: recordId,
      status,
      endedAt,
      input:
        !recordId || capture
          ? {
              messages,
              parameters: {
                ...options.parameters,
                roomId: options.roomId,
                submissionCount,
                omittedInputCount: Math.max(0, submissionCount - messages.length),
                outputAttribution: "accepted-room-batch-visible-output",
                limitation:
                  "Overlapping submissions have no per-request CLI output identity; internal model requests are opaque.",
              },
            }
          : undefined,
      output: capture && endedAt !== undefined ? { text, stopReason: status } : undefined,
      error,
    });
    if (result && !recordId) {
      recordId = result.id;
      capture = result.inputState !== "not-recorded";
      if (!capture) messages.length = 0;
    }
    if (!result && !recordId) messages.length = 0;
  };
  const span = (input: Parameters<typeof recordModelTraceEvent>[0]) =>
    withModelTraceContext(context, () =>
      recordModelTraceEvent({
        ...input,
        traceId,
        ...(!contentEnabled()
          ? {
              inputState: "not-recorded",
              outputState: "not-recorded",
              error: input.error ? "External room operation failed" : undefined,
            }
          : {}),
      }),
    );
  const finish = (status: ModelTraceStatus) => {
    if (ended) return;
    ended = true;
    const endedAt = Date.now();
    for (const tool of tools.values())
      span({ ...tool, endedAt, status: status === "failed" ? "failed" : "cancelled" });
    tools.clear();
    if (recordId) write(status, endedAt);
    messages.length = 0;
    text = "";
  };
  return {
    get ended() {
      return ended;
    },
    submit(input: string) {
      if (ended) return;
      submissionCount++;
      pending++;
      if ((!recordId || contentEnabled()) && messages.length < MAX_INPUTS)
        messages.push({ role: "user", content: input.slice(0, MAX_TEXT) });
      write("running");
    },
    observe(event: ResidentAgentEvent) {
      if (ended || !recordId) return;
      switch (event.type) {
        case "text":
          if (contentEnabled()) text = (text + event.text).slice(0, MAX_TEXT);
          else if (capture && !text.endsWith("[Content capture paused]"))
            text = (text + "\n[Content capture paused]").slice(0, MAX_TEXT);
          break;
        case "tool": {
          if (tools.size >= MAX_INPUTS) break;
          const tool = span({
            kind: "tool",
            name: event.tool,
            startedAt: Date.now(),
            status: event.id ? "running" : "observed",
            ...(event.id ? {} : { endedAt: Date.now() }),
            input: event.input,
          });
          if (tool && event.id) tools.set(event.id, tool);
          break;
        }
        case "tool_result": {
          const tool = event.id ? tools.get(event.id) : undefined;
          if (tool) {
            span({
              ...tool,
              endedAt: Date.now(),
              status: event.isError ? "failed" : "completed",
              output: event.summary,
              outputState: undefined,
            });
            tools.delete(event.id!);
          } else
            span({
              kind: "tool",
              name: "External CLI tool result (identity unavailable)",
              startedAt: Date.now(),
              status: event.isError ? "failed" : "completed",
              output: event.summary,
            });
          break;
        }
        case "approval_request":
          span({
            kind: "approval",
            name: event.toolName,
            startedAt: Date.now(),
            status: "requested",
            input: event.input,
          });
          break;
        case "error":
          error = contentEnabled() ? event.error.slice(0, MAX_TEXT) : "External room CLI failed";
          finish("failed");
          break;
        case "turn_end":
          span({
            kind: "lifecycle",
            name: "External room CLI turn boundary",
            startedAt: Date.now(),
            status: event.reason,
          });
          batchFailed ||= /error|fail/i.test(event.reason);
          batchCancelled ||= /abort|cancel|interrupt/i.test(event.reason);
          pending = Math.max(0, pending - 1);
          if (pending === 0)
            finish(batchFailed ? "failed" : batchCancelled ? "cancelled" : "completed");
          break;
        case "exit":
          finish(event.signal ? "cancelled" : "failed");
          break;
      }
    },
    finish,
  };
}
