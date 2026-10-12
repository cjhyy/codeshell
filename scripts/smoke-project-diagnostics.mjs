import { createHash } from "node:crypto";

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const smokeStages = new Set([
  "initializing",
  "create-fixture",
  "spawn-controller",
  "wait-controller",
  "verify-browser-authority",
  "authorize-controller-origin",
  "read-installation",
  "setup-admin",
  "verify-health",
  "create-project-a",
  "create-project-b",
  "start-project-a",
  "start-project-b",
  "verify-seccomp",
  "install-fixture",
  "verify-panel-binding",
  "verify-panel-process",
  "verify-native-task",
  "connect-project-a",
  "connect-project-b",
  "main-agent-approval",
  "panel-agent-task",
  "project-isolation",
  "panel-lifecycle",
  "job-hunt",
  "design",
  "video",
  "quant",
  "download",
  "stop-project",
  "offline-recovery",
  "restart-project",
  "restart-verification",
  "capture-runtime",
  "complete",
]);

export function summarizeSmokeProgress(stage, controller) {
  return {
    stage: smokeStages.has(stage) ? stage : "unknown",
    controller: {
      captured: !!controller,
      started: Number.isSafeInteger(controller?.pid) && controller.pid > 0,
      live: !!controller && controller.exitCode === null && controller.signalCode === null,
      exitCode:
        Number.isSafeInteger(controller?.exitCode) &&
        controller.exitCode >= 0 &&
        controller.exitCode <= 255
          ? controller.exitCode
          : undefined,
      signal: ["SIGTERM", "SIGKILL", "SIGINT"].includes(controller?.signalCode)
        ? controller.signalCode
        : undefined,
    },
  };
}

function guardRefusal(error) {
  const value = error && Object.getOwnPropertyDescriptor(error, "candidateGuardRefusal")?.value;
  if (
    !value ||
    typeof value !== "object" ||
    Object.getOwnPropertyNames(value).sort().join(",") !== "column,line,sha256,source,version"
  )
    return undefined;
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (field) => !Object.hasOwn(field, "value"),
    )
  )
    return undefined;
  if (
    value.version !== 1 ||
    value.source !== "docker-candidate-guard.mjs" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    return undefined;
  if (
    ![value.line, value.column].every(
      (number) => Number.isSafeInteger(number) && number >= 0 && number <= 10_000,
    ) ||
    (value.line === 0) !== (value.column === 0)
  )
    return undefined;
  return {
    version: 1,
    source: "docker-candidate-guard.mjs",
    sha256: value.sha256,
    line: value.line,
    column: value.column,
  };
}
const reasons = new Set([
  "completed",
  "stop_hook_prevented",
  "hook_stopped",
  "prompt_too_long",
  "model_error",
  "replay_incomplete",
  "unverified_write",
  "aborted_streaming",
  "aborted_tools",
  "max_turns",
  "goal_budget_exhausted",
  "image_error",
]);
const errorCodes = [
  "ENOENT",
  "EACCES",
  "EAGAIN",
  "ENOSPC",
  "EROFS",
  "ENOMEM",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNKNOWN_FILE_EXTENSION",
];
const categories = [
  ["settings", /settings|配置|模型设置/i],
  ["model", /model|模型|credential|凭证/i],
  ["worker", /worker|spawn|ENOENT|EACCES|ENOMEM/i],
  ["session", /session|会话/i],
  ["transport", /socket|transport|RPC timed out|connection/i],
  ["module", /module|package|ERR_MODULE_NOT_FOUND/i],
  ["timeout", /timed out|timeout|ETIMEDOUT/i],
];

class ApprovalRunError extends Error {
  constructor(outcome, diagnostic) {
    super(`Project A agent/run ${outcome} before Write approval: ${JSON.stringify(diagnostic)}`);
    this.diagnostic = { stage: `main-run-${outcome}-before-approval`, ...diagnostic };
  }
}

// Raw errors may contain settings, prompts, response bodies or credentials. Only
// fixed classifications, numeric RPC codes and a fingerprint leave the scratch.
export function summarizeFailure(error) {
  if (error instanceof ApprovalRunError) return error.diagnostic;
  const text = error instanceof Error ? error.message : String(error);
  let code;
  try {
    code = finite(JSON.parse(text)?.code);
  } catch {}
  return {
    code,
    errorCodes: errorCodes.filter((value) => new RegExp(`\\b${value}\\b`).test(text)),
    categories: categories.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    sha256: digest(text),
    guardRefusal: guardRefusal(error),
  };
}

export function summarizeRun(result) {
  return {
    reason: reasons.has(result?.reason) ? result.reason : "other",
    turnCount: finite(result?.turnCount),
  };
}

// Own all timers: a rejected/early-completed Run must stop waiting immediately,
// and a successful approval must not leave a timer or an unhandled Run rejection.
export function waitForRunApproval(messages, run, sessionId, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let poll;
    let deadline;
    const finish = (error, approval) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(approval);
    };
    const check = () => {
      const approval = messages.find(
        (message) =>
          message.method === "agent/approvalRequest" && message.params?.sessionId === sessionId,
      );
      if (approval) finish(undefined, approval);
    };
    poll = setInterval(check, 100);
    deadline = setTimeout(
      () => finish(new Error("Timed out: real main-agent Write approval")),
      timeout,
    );
    check();
    Promise.resolve(run).then(
      (result) => {
        check();
        finish(new ApprovalRunError("settled", summarizeRun(result)));
      },
      (error) => finish(new ApprovalRunError("rejected", summarizeFailure(error))),
    );
  });
}

const methods = new Set([
  "serve/hello",
  "serve/approvalSnapshot",
  "serve/sessionStatus",
  "serve/workerExit",
  "agent/runAccepted",
  "agent/streamEvent",
  "agent/approvalRequest",
]);
const events = new Set([
  "text_delta",
  "tool_use_start",
  "tool_use_args_delta",
  "tool_result",
  "turn_complete",
  "error",
]);

export function summarizeRpc(label, rpc) {
  return {
    project: ["A", "B", "A-restarted"].includes(label) ? label : "other",
    frames: rpc.messages.length,
    pending: rpc.pending.size,
    latest: rpc.messages.slice(-12).map((message) => ({
      method: methods.has(message.method) ? message.method : "response-or-other",
      error: message.error ? { code: finite(message.error.code) } : undefined,
      result: message.result ? summarizeRun(message.result) : undefined,
      running: typeof message.params?.running === "boolean" ? message.params.running : undefined,
      clean: typeof message.params?.clean === "boolean" ? message.params.clean : undefined,
      gaveUp: typeof message.params?.gaveUp === "boolean" ? message.params.gaveUp : undefined,
      approvals: Array.isArray(message.params?.approvals)
        ? message.params.approvals.length
        : undefined,
      event: events.has(message.params?.event?.type) ? message.params.event.type : undefined,
      streamError:
        message.params?.event?.type === "error"
          ? summarizeFailure(message.params.event.error)
          : undefined,
    })),
  };
}

export function summarizeContainerLogs(containerLog, fixtureLog) {
  let fixture;
  try {
    fixture = JSON.parse(fixtureLog);
  } catch {}
  const textSummary = (value) => {
    const text = typeof value === "string" ? value.slice(-60_000) : "unavailable";
    return {
      available: text !== "unavailable",
      bytes: Buffer.byteLength(text),
      ...summarizeFailure(text),
    };
  };
  const requests = String(fixture?.["model-requests.jsonl"] ?? "")
    .slice(-60_000)
    .split("\n");
  const parsed = [];
  let invalid = 0;
  for (const line of requests) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const tools = Array.isArray(request.tools) ? request.tools : [];
      parsed.push({
        model: request.model === "gpt-4o-mini" ? request.model : "other",
        messages: messages.length,
        toolResults: messages.filter((message) => message.role === "tool").length,
        tools: tools.length,
        readAvailable: tools.some((tool) => tool.function?.name === "Read"),
        writeAvailable: tools.some((tool) => tool.function?.name === "Write"),
      });
    } catch {
      invalid++;
    }
  }
  return {
    container: textSummary(containerLog),
    fixtureOutput: textSummary(fixture?.["model-output.log"]),
    fixtureErrors: textSummary(fixture?.["model-errors.log"]),
    modelRequests: { parsed: parsed.length, invalid, latest: parsed.slice(-5) },
  };
}
