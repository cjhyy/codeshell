import { createHash } from "node:crypto";
import { AssertionError } from "node:assert";
import { types } from "node:util";

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const panelIds = new Set([
  "design-studio",
  "job-hunt-hq",
  "quant-lab",
  "starter-panel",
  "video-download",
  "video-studio",
]);
const panelSteps = new Set([
  "controlled-update",
  "catalog-pin",
  "retained-page",
  "history",
  "select-updated",
  "stale-grant",
  "updated-page",
  "updated-storage",
  "select-original",
  "restored-page",
  "other-project-pin",
  "other-project-page",
  "other-project-storage",
]);
const panelUiSteps = new Set([
  "launch",
  "context",
  "snapshot",
  "navigate",
  "login",
  "open-panels",
  "review-first",
  "cancel-first",
  "review-second",
  "evidence",
  "confirm",
  "verify-selection",
  "verify-browser-errors",
  "close",
]);
const panelFailures = new WeakMap();
const ownValue = (value, key) => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
};
const jobPdfSteps = new Set([
  "preview",
  "request",
  "consent",
  "task",
  "task-input",
  "receipt",
  "resource",
  "cross-project-denial",
  "local-write",
  "text-extract",
  "text-english",
  "text-chinese",
  "text-private-exclusion",
  "text-evidence",
  "download",
  "evidence",
  "other-project",
]);
const jobPdfStatuses = new Set([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
const jobPdfFailures = new WeakMap();
const jobBrowserFailures = new WeakMap();
const jobPdfErrorCodes = new Set([
  "TOOL_FAILED",
  "HOST_INTERRUPTED",
  "CANCELLED",
  "APP_REVOKED",
  "PACKAGE_UNAVAILABLE",
  "PACKAGE_UNKNOWN",
  "PACKAGE_CHANGED",
  "INPUT_MISSING",
  "INPUT_CHANGED",
]);

function jobPdfTaskError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.sort().join(",") !== "code,message,retryable" ||
    Object.values(fields).some((field) => !("value" in field))
  )
    return undefined;
  const { code, message, retryable } = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, field.value]),
  );
  if (
    typeof code !== "string" ||
    code.length > 100 ||
    typeof message !== "string" ||
    message.length > 2000 ||
    typeof retryable !== "boolean"
  )
    return undefined;
  return Object.freeze({
    code: jobPdfErrorCodes.has(code) ? code : "other",
    retryable,
    categories: Object.freeze(
      categories.filter(([, pattern]) => pattern.test(message)).map(([name]) => name),
    ),
    sha256: digest(message),
  });
}

export function jobPdfFailure(error, step, details = {}) {
  if (
    !jobPdfSteps.has(step) ||
    !details ||
    typeof details !== "object" ||
    Reflect.ownKeys(details).some((key) => !["taskStatus", "taskError"].includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(details)).some((field) => !("value" in field)) ||
    (Object.hasOwn(details, "taskStatus") && !jobPdfStatuses.has(ownValue(details, "taskStatus")))
  )
    throw new TypeError("Invalid candidate Job PDF diagnostic context");
  // A malformed Host DTO provides no extra diagnosis; it must never replace the
  // original business failure or invoke an error/message getter.
  const taskError = jobPdfTaskError(ownValue(details, "taskError"));
  const failure = new Error("Candidate Job PDF acceptance step failed", { cause: error });
  jobPdfFailures.set(
    failure,
    Object.freeze({
      source: "candidate-job-hunt-pdf",
      step,
      error,
      ...(Object.hasOwn(details, "taskStatus")
        ? { taskStatus: ownValue(details, "taskStatus") }
        : {}),
      ...(taskError ? { taskError } : {}),
    }),
  );
  return failure;
}

function jobPdfContext(error) {
  const record = jobPdfFailures.get(error);
  if (!record) return undefined;
  if (
    ![
      "error,source,step",
      "error,source,step,taskError",
      "error,source,step,taskStatus",
      "error,source,step,taskError,taskStatus",
    ].includes(Object.keys(record).sort().join(","))
  )
    return undefined;
  if (Object.values(Object.getOwnPropertyDescriptors(record)).some((field) => !("value" in field)))
    return undefined;
  if (
    record.source !== "candidate-job-hunt-pdf" ||
    !jobPdfSteps.has(record.step) ||
    (Object.hasOwn(record, "taskStatus") && !jobPdfStatuses.has(record.taskStatus))
  )
    return undefined;
  return record;
}

// Keep the real browser action's failure even when evidence or close also fails.
export async function withJobHuntBrowserDiagnostics(run, capture, close) {
  let result, primary;
  let failed = false;
  const cleanup = [];
  const phases = [];
  try {
    result = await run();
  } catch (error) {
    failed = true;
    primary = error;
    try {
      await capture();
    } catch (error) {
      cleanup.push(error);
      phases.push("capture");
    }
  } finally {
    try {
      await close();
    } catch (error) {
      cleanup.push(error);
      phases.push("close");
    }
  }
  if (cleanup.length) {
    const failure = new AggregateError(
      [...(failed ? [primary] : []), ...cleanup],
      "Job Hunt browser acceptance and cleanup failed",
      failed ? { cause: primary } : undefined,
    );
    try {
      jobBrowserFailures.set(
        failure,
        Object.freeze({
          version: 1,
          source: "candidate-job-hunt-browser",
          failed,
          // Presence means run threw, even when its thrown value was undefined.
          primaryPresent: failed,
          ...(failed ? { primary: jobBrowserLeaf(primary) } : {}),
          cleanup: Object.freeze(
            cleanup.map((error, index) =>
              Object.freeze({ phase: phases[index], ...jobBrowserLeaf(error) }),
            ),
          ),
        }),
      );
    } catch {
      /* Diagnostic registration must not replace the original aggregate. */
    }
    throw failure;
  }
  if (failed) throw primary;
  return result;
}

function jobBrowserLeaf(error) {
  const unavailable = Object.freeze({ available: false });
  try {
    // Never traverse arbitrary aggregates, proxy traps, accessors or toString.
    if (types.isProxy(error) || !types.isNativeError(error)) return unavailable;
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (!message || !("value" in message) || typeof message.value !== "string") return unavailable;
    if (message.value.length > 16_384) return unavailable;
    const prototype = Object.getPrototypeOf(error);
    if (types.isProxy(prototype)) return unavailable;
    const assertion = prototype === AssertionError.prototype ? assertionNumbers(error) : undefined;
    return Object.freeze({
      available: true,
      errorCodes: Object.freeze(
        errorCodes.filter((value) => new RegExp(`\\b${value}\\b`).test(message.value)),
      ),
      categories: Object.freeze(
        categories.filter(([, pattern]) => pattern.test(message.value)).map(([name]) => name),
      ),
      sha256: digest(message.value),
      ...(assertion ? { assertion: Object.freeze(assertion) } : {}),
    });
  } catch {
    return unavailable;
  }
}

function panelFailure(error, panelId, kind, step) {
  if (!panelIds.has(panelId) || !(kind === "step" ? panelSteps : panelUiSteps).has(step))
    throw new TypeError("Invalid candidate Panel diagnostic context");
  const failure = new Error("Candidate Panel acceptance step failed", { cause: error });
  panelFailures.set(
    failure,
    Object.freeze({ source: "candidate-panel-lifecycle", panelId, kind, step, error }),
  );
  return failure;
}

export const panelLifecycleFailure = (error, panelId, step) =>
  panelFailure(error, panelId, "step", step);
export const panelVersionUiFailure = (error, panelId, step) =>
  panelFailure(error, panelId, "uiStep", step);

function panelContext(error) {
  const record = panelFailures.get(error);
  if (!record) return undefined;
  if (Object.keys(record).sort().join(",") !== "error,kind,panelId,source,step") return undefined;
  if (Object.values(Object.getOwnPropertyDescriptors(record)).some((field) => !("value" in field)))
    return undefined;
  const { source, panelId, kind, step } = record;
  if (
    source !== "candidate-panel-lifecycle" ||
    !panelIds.has(panelId) ||
    !["step", "uiStep"].includes(kind) ||
    !(kind === "step" ? panelSteps : panelUiSteps).has(step)
  )
    return undefined;
  return record;
}

function assertionNumbers(error) {
  if (!(error instanceof AssertionError)) return undefined;
  const output = {};
  for (const key of ["actual", "expected"]) {
    const value = ownValue(error, key);
    if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000)
    )
      output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}
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
  const summary = summarizeFailureAt(error, 0, false);
  const browser = jobBrowserFailures.get(error);
  return browser ? { ...summary, jobBrowser: browser } : summary;
}

function summarizeFailureAt(error, depth, trustedPanel) {
  const job = depth < 8 ? jobPdfContext(error) : undefined;
  if (job) {
    const summary = summarizeFailureAt(job.error, depth + 1, true);
    return {
      ...summary,
      jobPdf: {
        source: job.source,
        step: job.step,
        ...(Object.hasOwn(job, "taskStatus") ? { taskStatus: job.taskStatus } : {}),
        ...(Object.hasOwn(job, "taskError") ? { taskError: job.taskError } : {}),
      },
    };
  }
  const context = depth < 8 ? panelContext(error) : undefined;
  if (context) {
    const summary = summarizeFailureAt(context.error, depth + 1, true);
    return {
      ...summary,
      panelLifecycle: {
        ...(summary.panelLifecycle?.panelId === context.panelId ? summary.panelLifecycle : {}),
        source: context.source,
        panelId: context.panelId,
        [context.kind]: context.step,
      },
    };
  }
  // Only our own wrapped primary failure authorizes this aggregate's cause.
  // The thrown AggregateError still retains both primary and cleanup errors.
  const cause = ownValue(error, "cause");
  if (depth < 8 && error instanceof AggregateError && (panelContext(cause) || jobPdfContext(cause)))
    return summarizeFailureAt(cause, depth + 1, true);
  if (error instanceof ApprovalRunError) return error.diagnostic;
  const text = trustedPanel
    ? error instanceof Error
      ? typeof ownValue(error, "message") === "string"
        ? ownValue(error, "message")
        : "Unavailable Panel error message"
      : error === null || !["object", "function"].includes(typeof error)
        ? String(error)
        : "Non-Error Panel failure"
    : error instanceof Error
      ? error.message
      : String(error);
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
    ...(trustedPanel && assertionNumbers(error) ? { assertion: assertionNumbers(error) } : {}),
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
