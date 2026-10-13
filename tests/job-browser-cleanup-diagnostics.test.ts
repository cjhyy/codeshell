import { expect, test } from "bun:test";
import { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import {
  jobPdfFailure,
  summarizeFailure,
  withJobHuntBrowserDiagnostics,
} from "../scripts/smoke-project-diagnostics.mjs";

const secret = "private-account-cookie-grant-html-argv-never-print";
const digest = (text) => createHash("sha256").update(text).digest("hex");
async function caught(run, capture, close) {
  try {
    await withJobHuntBrowserDiagnostics(run, capture, close);
  } catch (error) {
    return error;
  }
  throw new Error("Expected the owned browser wrapper to fail");
}

test("owned browser summary separates primary, capture and close without changing the aggregate", async () => {
  const primary = new AssertionError({ actual: 403, expected: 200, message: secret });
  const capture = new Error(`ENOENT ${secret}`);
  const close = new Error(`socket timed out ${secret}`);
  const calls = [];
  const failure = await caught(
    async () => {
      calls.push("run");
      throw primary;
    },
    async () => {
      calls.push("capture");
      throw capture;
    },
    async () => {
      calls.push("close");
      throw close;
    },
  );
  expect(calls).toEqual(["run", "capture", "close"]);
  expect(failure.errors).toEqual([primary, capture, close]);
  expect(failure.cause).toBe(primary);
  const summary = summarizeFailure(failure);
  expect(summary.sha256).toBe(digest("Job Hunt browser acceptance and cleanup failed"));
  expect(summary.jobBrowser.source).toBe("candidate-job-hunt-browser");
  expect(summary.jobBrowser.version).toBe(1);
  expect(summary.jobBrowser.failed).toBe(true);
  expect(summary.jobBrowser.primaryPresent).toBe(true);
  expect(summary.jobBrowser.primary.sha256).toBe(digest(secret));
  expect(summary.jobBrowser.primary.assertion).toEqual({ actual: 403, expected: 200 });
  expect(summary.jobBrowser.cleanup.map((leaf) => leaf.phase)).toEqual(["capture", "close"]);
  expect(summary.jobBrowser.cleanup[0].errorCodes).toEqual(["ENOENT"]);
  expect(summary.jobBrowser.cleanup[1].categories).toEqual(["transport", "timeout"]);
  expect(summary.jobBrowser.cleanup.map((leaf) => leaf.sha256)).toEqual([
    digest(capture.message),
    digest(close.message),
  ]);
  expect(JSON.stringify(summary)).not.toContain(secret);
});

test("cleanup-only failure is distinguished from a captured primary, and capture is not called", async () => {
  const close = new Error(secret);
  const calls = [];
  const failure = await caught(
    async () => calls.push("run"),
    async () => calls.push("capture"),
    async () => {
      calls.push("close");
      throw close;
    },
  );
  expect(calls).toEqual(["run", "close"]);
  expect(failure.errors).toEqual([close]);
  expect(Object.hasOwn(failure, "cause")).toBe(false);
  const context = summarizeFailure(failure).jobBrowser;
  expect(context.failed).toBe(false);
  expect(context.primaryPresent).toBe(false);
  expect(Object.hasOwn(context, "primary")).toBe(false);
  expect(context.cleanup).toHaveLength(1);
  expect(context.cleanup[0].phase).toBe("close");
  expect(context.cleanup[0].sha256).toBe(digest(secret));
});

test("primary presence is true for undefined, null, zero and false even when leaves are unavailable", async () => {
  for (const primary of [undefined, null, 0, false]) {
    const failure = await caught(
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
    expect(failure.errors).toEqual([primary, undefined, false]);
    expect(Object.hasOwn(failure, "cause")).toBe(true);
    expect(failure.cause).toBe(primary);
    const context = summarizeFailure(failure).jobBrowser;
    expect(context.failed).toBe(true);
    expect(context.primaryPresent).toBe(true);
    expect(context.primary).toEqual({ available: false });
    expect(context.cleanup).toEqual([
      { phase: "capture", available: false },
      { phase: "close", available: false },
    ]);
  }
});

test("primary-only failure keeps its exact identity and trusted PDF summary remains intact", async () => {
  const original = new AssertionError({ actual: false, expected: true, message: secret });
  const primary = jobPdfFailure(original, "resource", { taskStatus: "succeeded" });
  const failure = await caught(
    async () => {
      throw primary;
    },
    async () => {},
    async () => {},
  );
  expect(failure).toBe(primary);
  expect(summarizeFailure(failure).jobBrowser).toBeUndefined();
  const aggregate = await caught(
    async () => {
      throw primary;
    },
    async () => {},
    async () => {
      throw new Error(secret);
    },
  );
  const summary = summarizeFailure(aggregate);
  expect(aggregate.errors[0]).toBe(primary);
  expect(aggregate.cause).toBe(primary);
  expect(summary.sha256).toBe(digest(secret));
  expect(summary.jobPdf).toEqual({
    source: "candidate-job-hunt-pdf",
    step: "resource",
    taskStatus: "succeeded",
  });
  expect(summary.assertion).toEqual({ actual: false, expected: true });
  expect(summary.jobBrowser.primaryPresent).toBe(true);
});

test("leaf projection does not invoke native-error accessors, object coercion or proxy traps", async () => {
  let reads = 0;
  const accessor = Object.defineProperty(new Error(secret), "message", {
    get() {
      reads++;
      throw new Error(secret);
    },
  });
  const object = {
    toString() {
      reads++;
      return secret;
    },
  };
  const proxy = new Proxy(new Error(secret), {
    get() {
      reads++;
      throw new Error(secret);
    },
    getOwnPropertyDescriptor() {
      reads++;
      throw new Error(secret);
    },
    getPrototypeOf() {
      reads++;
      throw new Error(secret);
    },
  });
  const poisonedPrototype = Object.setPrototypeOf(new Error(secret), proxy);
  const revoked = Proxy.revocable(new Error(secret), {});
  revoked.revoke();
  for (const primary of [accessor, object, proxy, poisonedPrototype, revoked.proxy]) {
    const failure = await caught(
      async () => {
        throw primary;
      },
      async () => {
        throw accessor;
      },
      async () => {
        throw proxy;
      },
    );
    const summary = summarizeFailure(failure);
    expect(summary.jobBrowser.primary).toEqual({ available: false });
    expect(summary.jobBrowser.cleanup.every((leaf) => leaf.available === false)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(secret);
  }
  expect(reads).toBe(0);
});

test("forged aggregates cannot mint context and neither arbitrary errors nor spoofed getters are read", () => {
  let reads = 0;
  const forged = new AggregateError([], "Job Hunt browser acceptance and cleanup failed");
  for (const key of ["errors", "cause", "jobBrowser", "candidateJobBrowser"]) {
    Object.defineProperty(forged, key, {
      get() {
        reads++;
        throw new Error(secret);
      },
    });
  }
  const summary = summarizeFailure(forged);
  expect(summary.jobBrowser).toBeUndefined();
  expect(JSON.stringify(summary)).not.toContain(secret);
  expect(reads).toBe(0);
});

test("owned leaves are frozen snapshots, not a later read of AggregateError.errors", async () => {
  const primary = new Error(secret);
  const close = new Error(`socket ${secret}`);
  const failure = await caught(
    async () => {
      throw primary;
    },
    async () => {},
    async () => {
      throw close;
    },
  );
  let reads = 0;
  for (const [object, key] of [
    [failure, "errors"],
    [primary, "message"],
    [close, "message"],
  ])
    Object.defineProperty(object, key, {
      get() {
        reads++;
        throw new Error(secret);
      },
    });
  const context = summarizeFailure(failure).jobBrowser;
  expect(context.primary.sha256).toBe(digest(secret));
  expect(context.cleanup[0].sha256).toBe(digest(`socket ${secret}`));
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.cleanup)).toBe(true);
  expect(Object.isFrozen(context.cleanup[0])).toBe(true);
  expect(reads).toBe(0);
});

test("large messages and non-native Error lookalikes remain unavailable, with fixed output bounds", async () => {
  for (const primary of [new Error(secret.repeat(1000)), Object.create(Error.prototype)]) {
    const failure = await caught(
      async () => {
        throw primary;
      },
      async () => {},
      async () => {
        throw undefined;
      },
    );
    const summary = summarizeFailure(failure);
    expect(summary.jobBrowser.primary).toEqual({ available: false });
    expect(summary.jobBrowser.cleanup).toHaveLength(1);
    expect(JSON.stringify(summary).length).toBeLessThan(4096);
    expect(JSON.stringify(summary)).not.toContain(secret);
  }
  const text =
    `ENOENT EACCES EAGAIN ENOSPC EROFS ENOMEM ECONNREFUSED ECONNRESET ETIMEDOUT ERR_MODULE_NOT_FOUND ERR_PACKAGE_PATH_NOT_EXPORTED ERR_UNKNOWN_FILE_EXTENSION settings model worker session transport module timeout ${secret}`.padEnd(
      16_384,
      "x",
    );
  const failure = await caught(
    async () => {
      throw new Error(text);
    },
    async () => {
      throw new Error(text);
    },
    async () => {
      throw new Error(text);
    },
  );
  const summary = summarizeFailure(failure);
  expect(summary.jobBrowser.primary.available).toBe(true);
  expect(summary.jobBrowser.cleanup).toHaveLength(2);
  expect(JSON.stringify(summary).length).toBeLessThan(4096);
  expect(JSON.stringify(summary)).not.toContain(secret);
});
