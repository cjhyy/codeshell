import { expect, test } from "bun:test";
import assert, { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  jobPdfFailure,
  summarizeFailure,
  withJobHuntBrowserDiagnostics,
} from "../scripts/smoke-project-diagnostics.mjs";

const secret = "private-html-pdf-account-url-password-cookie-grant-argv-never-print";
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("PDF diagnostics preserve the leaf and fixed step/status without private text", () => {
  for (const step of [
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
  ]) {
    const original = new Error(secret);
    const wrapped = jobPdfFailure(original, step, { taskStatus: "failed" });
    expect(wrapped.cause).toBe(original);
    const summary = summarizeFailure(wrapped);
    expect(summary.jobPdf).toEqual({
      source: "candidate-job-hunt-pdf",
      step,
      taskStatus: "failed",
    });
    expect(summary.sha256).toBe(digest(secret));
    expect(JSON.stringify(summary)).not.toContain(secret);
  }
});

test("PDF context rejects unknown steps/status/fields and accessor projections without invoking them", () => {
  let getters = 0;
  const accessor = Object.defineProperty({}, "taskStatus", {
    get() {
      getters++;
      return "failed";
    },
  });
  for (const [step, details] of [
    [secret, {}],
    ["task", { taskStatus: secret }],
    ["task", { taskStatus: undefined }],
    ["task", { taskStatus: { password: secret } }],
    ["task", { rawError: secret }],
    ["task", { [Symbol("private")]: secret }],
    ["task", accessor],
    ["task", null],
  ])
    expect(() => jobPdfFailure(new Error(secret), step, details)).toThrow(
      "Invalid candidate Job PDF diagnostic context",
    );
  expect(getters).toBe(0);
  for (const taskStatus of [
    "queued",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ])
    expect(
      summarizeFailure(jobPdfFailure(new Error(secret), "task", { taskStatus })).jobPdf.taskStatus,
    ).toBe(taskStatus);
});

test("forged PDF metadata and message/assertion getters cannot manufacture or leak diagnostics", () => {
  let getters = 0;
  const forged = Object.defineProperty(new Error(secret), "jobPdf", {
    get() {
      getters++;
      return { source: "candidate-job-hunt-pdf", step: "task" };
    },
  });
  expect(summarizeFailure(forged).jobPdf).toBeUndefined();
  const error = new AssertionError({ actual: secret, expected: secret, message: secret });
  for (const key of ["message", "actual", "expected", "candidateGuardRefusal"])
    Object.defineProperty(error, key, {
      get() {
        getters++;
        throw new Error(secret);
      },
    });
  const summary = summarizeFailure(jobPdfFailure(error, "task"));
  expect(summary.assertion).toBeUndefined();
  expect(JSON.stringify(summary)).not.toContain(secret);
  expect(getters).toBe(0);
});

test("Host task error exposes only fixed code/classification, retryable and leaf fingerprint", () => {
  const original = new Error("Cloud PDF failed: " + secret);
  for (const code of ["TOOL_FAILED", "APP_REVOKED", "PACKAGE_CHANGED", secret]) {
    const taskError = { code, message: "spawn timed out: " + secret, retryable: false };
    const wrapped = jobPdfFailure(original, "task", { taskStatus: "failed", taskError });
    expect(wrapped.cause).toBe(original);
    const summary = summarizeFailure(wrapped);
    expect(summary.sha256).toBe(digest(original.message));
    expect(summary.jobPdf.taskError).toEqual({
      code: code === secret ? "other" : code,
      categories: ["worker", "timeout"],
      retryable: false,
      sha256: digest(taskError.message),
    });
    taskError.message = "changed after wrapping";
    expect(summarizeFailure(wrapped).jobPdf.taskError.sha256).toBe(
      digest("spawn timed out: " + secret),
    );
    expect(JSON.stringify(summary)).not.toContain(secret);
  }
});

test("malformed Host task errors add no leaf and never replace the original failure or read getters", () => {
  let getters = 0;
  const valid = { code: "TOOL_FAILED", message: secret, retryable: true };
  for (const taskError of [
    null,
    secret,
    [],
    { ...valid, raw: secret },
    { ...valid, [Symbol("private")]: secret },
    { ...valid, code: secret.repeat(3) },
    { ...valid, message: secret.repeat(50) },
    { ...valid, retryable: secret },
    Object.defineProperty({ ...valid }, "message", {
      get() {
        getters++;
        throw new Error(secret);
      },
    }),
    Object.create(valid),
  ]) {
    const original = new Error(secret);
    const wrapped = jobPdfFailure(original, "task", { taskError });
    expect(wrapped.cause).toBe(original);
    expect(summarizeFailure(wrapped).sha256).toBe(digest(secret));
    expect(summarizeFailure(wrapped).jobPdf.taskError).toBeUndefined();
  }
  const details = Object.defineProperty({}, "taskError", {
    get() {
      getters++;
      throw new Error(secret);
    },
  });
  expect(() => jobPdfFailure(new Error(secret), "task", details)).toThrow(
    "Invalid candidate Job PDF diagnostic context",
  );
  expect(getters).toBe(0);
});

test("actual PDF task polling preserves the original throw and projects its Host error leaf", async () => {
  const source = readFileSync(
    new URL("../scripts/smoke-cloud-job-hunt-recovery.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf('    let pdfStep = "preview";');
  const body = source.slice(start, source.indexOf("    verifyAudioRestart =", start));
  const ownData = source.slice(
    source.indexOf("const ownDataValue ="),
    source.indexOf("\nasync function until"),
  );
  const taskError = { code: "TOOL_FAILED", message: "spawn failed: " + secret, retryable: true };
  let currentJob: unknown = { status: "failed", error: taskError };
  const calls = [];
  const locator = {
    async click() {},
    async waitFor() {},
    locator: (name) => ({
      async innerText() {
        return name === "h2" ? "启动 Job 的后台工具？" : "resume-pdf";
      },
    }),
    getByRole() {
      return this;
    },
  };
  const run = runInNewContext(ownData + "\n(async () => {" + body + "})", {
    assert: assert.strict,
    Error,
    jobPdfFailure,
    a: {
      frame: { locator: () => locator },
      page: { locator: () => locator },
      async call(method) {
        calls.push(method);
        return method === "tasks.list"
          ? [{ id: "private-task-id", entry: { name: "resume-pdf" } }]
          : currentJob;
      },
    },
    until: async (read) => read(),
  });
  let failure;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  expect(calls).toEqual(["tasks.list", "tasks.get"]);
  expect(failure.cause.message).toBe(`Cloud PDF failed: ${JSON.stringify(taskError)}`);
  const summary = summarizeFailure(failure);
  expect(summary.sha256).toBe(digest(failure.cause.message));
  expect(summary.jobPdf).toEqual({
    source: "candidate-job-hunt-pdf",
    step: "task",
    taskStatus: "failed",
    taskError: {
      code: "TOOL_FAILED",
      retryable: true,
      categories: ["worker"],
      sha256: digest(taskError.message),
    },
  });
  expect(JSON.stringify(summary)).not.toContain(secret);
  for (const job of [null, undefined]) {
    currentJob = job;
    try {
      await run();
    } catch (error) {
      failure = error;
    }
    expect(failure.cause.message).toContain("status");
    expect(summarizeFailure(failure).jobPdf).toEqual({
      source: "candidate-job-hunt-pdf",
      step: "task",
    });
  }
});

test("only native assertion own bounded numeric/boolean fields accompany a PDF failure", () => {
  for (const [actual, expected] of [
    [false, true],
    [403, 200],
    [-1_000_000, 1_000_000],
  ]) {
    const error = new AssertionError({ actual, expected, message: secret });
    expect(summarizeFailure(jobPdfFailure(error, "cross-project-denial")).assertion).toEqual({
      actual,
      expected,
    });
  }
  for (const value of [secret, { html: secret }, [], Infinity, NaN, 1_000_001]) {
    const error = new AssertionError({ actual: value, expected: value, message: secret });
    const summary = summarizeFailure(jobPdfFailure(error, "text-english"));
    expect(summary.assertion).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain(secret);
  }
  expect(
    summarizeFailure(
      jobPdfFailure(Object.assign(new Error(secret), { actual: 403, expected: 200 }), "task"),
    ).assertion,
  ).toBeUndefined();
});

test("trusted primary PDF metadata survives evidence and browser-close failure aggregation", async () => {
  const original = new AssertionError({ actual: 403, expected: 200, message: secret });
  const primary = jobPdfFailure(original, "resource", { taskStatus: "succeeded" });
  const evidence = new Error("private evidence path");
  const close = new Error("private browser error");
  const calls = [];
  let failure;
  try {
    await withJobHuntBrowserDiagnostics(
      async () => {
        calls.push("run");
        throw primary;
      },
      async () => {
        calls.push("capture");
        throw evidence;
      },
      async () => {
        calls.push("close");
        throw close;
      },
    );
  } catch (error) {
    failure = error;
  }
  expect(calls).toEqual(["run", "capture", "close"]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([primary, evidence, close]);
  expect(failure.cause).toBe(primary);
  const summary = summarizeFailure(failure);
  expect(summary.sha256).toBe(digest(secret));
  expect(summary.jobPdf).toEqual({
    source: "candidate-job-hunt-pdf",
    step: "resource",
    taskStatus: "succeeded",
  });
  expect(summary.assertion).toEqual({ actual: 403, expected: 200 });
  expect(JSON.stringify(summary)).not.toMatch(/private evidence|private browser/);
});

test("browser cleanup preserves false/undefined primary and cleanup failures by presence", async () => {
  for (const primary of [false, undefined]) {
    let failure;
    try {
      await withJobHuntBrowserDiagnostics(
        async () => {
          throw primary;
        },
        async () => {
          throw undefined;
        },
        async () => {
          throw false;
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure.errors).toEqual([primary, undefined, false]);
    expect(Object.hasOwn(failure, "cause")).toBe(true);
    expect(failure.cause).toBe(primary);
  }
});

test("normal browser result closes once without capture; cleanup-only failure remains failure", async () => {
  const calls = [];
  expect(
    await withJobHuntBrowserDiagnostics(
      async () => {
        calls.push("run");
        return 42;
      },
      async () => {
        calls.push("capture");
      },
      async () => {
        calls.push("close");
      },
    ),
  ).toBe(42);
  expect(calls).toEqual(["run", "close"]);
  let failure;
  try {
    await withJobHuntBrowserDiagnostics(
      async () => 42,
      async () => {},
      async () => {
        throw false;
      },
    );
  } catch (error) {
    failure = error;
  }
  expect(failure.errors).toEqual([false]);
  expect(Object.hasOwn(failure, "cause")).toBe(false);
});

// Execute the actual browserRun body with controlled faults; no browser/network
// or Core is started. This verifies the consumer's evidence/close wiring.
test("actual Job Hunt browserRun retains PDF primary and all evidence/close failures", async () => {
  const source = readFileSync(
    new URL("../scripts/smoke-cloud-job-hunt-recovery.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  async function browserRun(action)");
  const body = source.slice(start, source.indexOf("\n  const edit =", start));
  let screenshots = 0,
    texts = 0,
    writes = 0,
    closes = 0;
  const primary = jobPdfFailure(new Error(secret), "task", { taskStatus: "failed" });
  const shotError = new Error("private screenshot path");
  const textError = new Error("private frame text");
  const writeError = new Error("private write path");
  const closeError = new Error("private close");
  const frame = { async waitForFunction() {}, async evaluate() {} };
  const locator = {
    async fill() {},
    async click() {},
    async waitFor() {},
    filter() {
      return this;
    },
    getByRole() {
      return this;
    },
    async elementHandle() {
      return { contentFrame: () => frame };
    },
  };
  const page = {
    on() {},
    async goto() {},
    getByLabel: () => locator,
    getByRole: () => locator,
    locator: () => locator,
    async screenshot() {
      screenshots++;
      throw shotError;
    },
    frames: () => [
      {
        locator: () => ({
          async innerText() {
            texts++;
            throw textError;
          },
        }),
      },
    ],
  };
  const browserRun = runInNewContext(body + "; browserRun;", {
    assert: assert.strict,
    AggregateError,
    join,
    secret,
    withJobHuntBrowserDiagnostics,
    chromium: {
      async launch() {
        return {
          async close() {
            closes++;
            throw closeError;
          },
        };
      },
    },
    browserGuard: {
      async createContext() {
        return {
          async newPage() {
            return page;
          },
        };
      },
    },
    writeFile: async () => {
      writes++;
      throw writeError;
    },
    speechFixture: undefined,
    evidenceDir: "/unused-controlled-fixture",
    serverUrl: "http://127.0.0.1:1",
    password: secret,
  });
  let failure;
  try {
    await browserRun(async (open) => {
      await open("project");
      throw primary;
    });
  } catch (error) {
    failure = error;
  }
  expect([screenshots, texts, writes, closes]).toEqual([1, 1, 1, 1]);
  expect(failure.cause).toBe(primary);
  expect(failure.errors[0]).toBe(primary);
  expect(failure.errors[1].errors).toEqual([shotError, textError, writeError]);
  expect(failure.errors[2]).toBe(closeError);
  expect(summarizeFailure(failure).jobPdf.step).toBe("task");
  expect(JSON.stringify(summarizeFailure(failure))).not.toContain(secret);
});
