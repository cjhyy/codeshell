import { expect, test } from "bun:test";
import assert, { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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
  expect(summarizeFailure(failure).jobBrowser.primaryStep).toBe("action");
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

test("wrapper-owned steps freeze at primary catch and ignore unknown, forged and late marks", async () => {
  let marker;
  let traps = 0;
  const forged = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error(secret);
      },
      getPrototypeOf() {
        traps++;
        throw new Error(secret);
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error(secret);
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const primary = new Error(secret);
  const failure = await caught(
    async (mark) => {
      marker = mark;
      expect(mark("audio-download-read-assert")).toBe(true);
      for (const value of [secret, {}, forged, revoked.proxy, () => secret, null, 1])
        expect(mark(value)).toBe(false);
      throw primary;
    },
    async () => {
      expect(marker("page-errors")).toBe(false);
    },
    async () => {
      expect(marker("speech-provider-log-read")).toBe(false);
    },
  );
  expect(failure).toBe(primary);
  expect(marker("audio-close-interview")).toBe(false);
  const summary = summarizeFailure(failure);
  expect(summary.sha256).toBe(digest(secret));
  expect(summary.jobBrowser.primaryStep).toBe("audio-download-read-assert");
  expect(summary.jobBrowser.primaryPresent).toBe(true);
  expect(summary.jobBrowser.cleanup).toEqual([]);
  expect(traps).toBe(0);
  expect(JSON.stringify(summary)).not.toContain(secret);
});

test("primary-only safe snapshots never evaluate unknown Error fields or prototype traps", async () => {
  let traps = 0;
  const accessor = Object.defineProperty(new Error(secret), "message", {
    get() {
      traps++;
      throw new Error(secret);
    },
  });
  const object = {
    toString() {
      traps++;
      throw new Error(secret);
    },
  };
  const proxy = new Proxy(new Error(secret), {
    get() {
      traps++;
      throw new Error(secret);
    },
    getPrototypeOf() {
      traps++;
      throw new Error(secret);
    },
    getOwnPropertyDescriptor() {
      traps++;
      throw new Error(secret);
    },
  });
  const revoked = Proxy.revocable(new Error(secret), {});
  revoked.revoke();
  const deeperPrototype = Object.setPrototypeOf(new Error(secret), Object.create(proxy));
  const metadata = Object.defineProperty(new Error(secret), "candidateGuardRefusal", {
    value: proxy,
  });
  for (const primary of [accessor, object, proxy, revoked.proxy, deeperPrototype, metadata]) {
    let failure,
      rejected = false;
    try {
      await withJobHuntBrowserDiagnostics(
        async (mark) => {
          mark("speech-provider-log-read");
          throw primary;
        },
        async () => {},
        async () => {},
      );
    } catch (error) {
      failure = error;
      rejected = true;
    }
    // Returning a Proxy from an async test helper would itself read .then.
    expect(rejected).toBe(true);
    expect(failure === primary).toBe(true);
    const summary = summarizeFailure(failure);
    expect(summary.jobBrowser.primaryStep).toBe("speech-provider-log-read");
    expect(summary.guardRefusal).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain(secret);
  }
  expect(traps).toBe(0);
});

test("primary-only preserves safe guard DTO and snapshots before capture can mutate the error", async () => {
  const metadata = {
    version: 1,
    source: "docker-candidate-guard.mjs",
    sha256: "a".repeat(64),
    line: 20,
    column: 3,
  };
  const primary = Object.defineProperty(new Error(secret), "candidateGuardRefusal", {
    value: metadata,
  });
  let reads = 0;
  const failure = await caught(
    async (mark) => {
      mark("speech-provider-receipt-write");
      throw primary;
    },
    async () => {
      Object.defineProperty(primary, "message", {
        get() {
          reads++;
          throw new Error(secret);
        },
      });
      Object.defineProperty(metadata, "line", {
        get() {
          reads++;
          throw new Error(secret);
        },
      });
    },
    async () => {},
  );
  expect(failure).toBe(primary);
  const summary = summarizeFailure(failure);
  expect(summary.sha256).toBe(digest(secret));
  expect(summary.guardRefusal).toEqual({
    version: 1,
    source: "docker-candidate-guard.mjs",
    sha256: "a".repeat(64),
    line: 20,
    column: 3,
  });
  expect(summary.jobBrowser.primaryStep).toBe("speech-provider-receipt-write");
  expect(summary.jobBrowser.primary.sha256).toBe(digest(secret));
  expect(reads).toBe(0);
});

test("primary-only keeps existing trusted PDF summaries for bounded and unavailable leaves", async () => {
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
      throw new Error(secret);
    },
  };
  const large = new AssertionError({ actual: false, expected: true, message: secret.repeat(1000) });
  for (const original of [new Error(secret), accessor, object, large, undefined, null, false, 0]) {
    const primary = jobPdfFailure(original, "resource", { taskStatus: "succeeded" });
    const expected = summarizeFailure(primary);
    const failure = await caught(
      async () => {
        throw primary;
      },
      async () => {},
      async () => {},
    );
    expect(failure).toBe(primary);
    const { jobBrowser, ...summary } = summarizeFailure(failure);
    expect(summary).toEqual(expected);
    expect(jobBrowser.primaryStep).toBe("action");
    expect(jobBrowser.primaryPresent).toBe(true);
    expect(JSON.stringify({ summary, jobBrowser })).not.toContain(secret);
  }
  expect(reads).toBe(0);
});

test("primary-only primitive failures keep exact thrown values without boxing or minting context", async () => {
  for (const primary of [undefined, null, false, 0]) {
    let captured = false;
    let marker;
    try {
      await withJobHuntBrowserDiagnostics(
        async (mark) => {
          marker = mark;
          mark("page-errors");
          throw primary;
        },
        async () => {
          captured = true;
        },
        async () => {},
      );
      throw new Error("Expected original primitive rejection");
    } catch (error) {
      expect(error).toBe(primary);
    }
    expect(captured).toBe(true);
    expect(marker("action")).toBe(false);
    expect(summarizeFailure(primary).jobBrowser).toBeUndefined();
  }
});

// Execute the actual owned capture body with controlled page/file doubles.
// This is neither Chromium nor a physical UI acceptance result.
function captureFixture(pages, writeFile) {
  const source = readFileSync(
    new URL("../scripts/smoke-cloud-job-hunt-recovery.mjs", import.meta.url),
    "utf8",
  );
  const start = source.lastIndexOf("async () => {", source.indexOf("const failures = [];"));
  const end = source.indexOf("\n      () => browser.close(),", start);
  const callback = source.slice(start, end).trim().replace(/,$/, "");
  return runInNewContext(`(${callback})`, {
    pages,
    evidenceDir: "owned-fixture",
    join: (...parts) => parts.join("/"),
    writeFile,
    AggregateError,
  });
}

test("actual capture skips deliberately closed pages while primary-only diagnostics remain visible", async () => {
  let screenshots = 0,
    frames = 0,
    writes = 0;
  const capture = captureFixture(
    [
      {
        isClosed: () => true,
        screenshot() {
          screenshots++;
        },
        frames() {
          frames++;
        },
      },
    ],
    async () => {
      writes++;
    },
  );
  const primary = new Error(secret);
  const failure = await caught(
    async (mark) => {
      mark("audio-download-save");
      throw primary;
    },
    capture,
    async () => {},
  );
  expect(failure).toBe(primary);
  expect(summarizeFailure(failure).jobBrowser.primaryStep).toBe("audio-download-save");
  expect(summarizeFailure(failure).jobBrowser.cleanup).toEqual([]);
  expect([screenshots, frames, writes]).toEqual([0, 0, 0]);
});

test("actual capture still aggregates every live-page evidence failure with the unchanged primary", async () => {
  const primary = new Error(secret),
    screenshot = new Error(secret),
    frame = new Error(secret),
    write = new Error(secret);
  let screenshots = 0,
    frames = 0,
    writes = 0,
    closedAttempts = 0;
  const capture = captureFixture(
    [
      {
        isClosed: () => true,
        screenshot() {
          closedAttempts++;
        },
        frames() {
          closedAttempts++;
        },
      },
      {
        isClosed: () => false,
        async screenshot() {
          screenshots++;
          throw screenshot;
        },
        frames() {
          frames++;
          return [
            {
              locator() {
                return {
                  async innerText() {
                    throw frame;
                  },
                };
              },
            },
          ];
        },
      },
    ],
    async () => {
      writes++;
      throw write;
    },
  );
  const failure = await caught(
    async (mark) => {
      mark("audio-download-save");
      throw primary;
    },
    capture,
    async () => {},
  );
  expect(failure.cause).toBe(primary);
  expect(failure.errors[0]).toBe(primary);
  expect(failure.errors[1].errors).toEqual([screenshot, frame, write]);
  expect(failure.errors[1].cause).toBe(screenshot);
  expect(summarizeFailure(failure).jobBrowser.primaryStep).toBe("audio-download-save");
  expect(summarizeFailure(failure).jobBrowser.cleanup.map((leaf) => leaf.phase)).toEqual([
    "capture",
  ]);
  expect([closedAttempts, screenshots, frames, writes]).toEqual([0, 1, 1, 1]);
});

test("actual audio download and returned restart closure explicitly use the new run marker", async () => {
  const source = readFileSync(
    new URL("../scripts/smoke-cloud-interview-audio.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const download = async (client, marker) => {");
  const end = source.indexOf('\n  markStep?.("audio-close-interview");', start);
  const downloadBody = source
    .slice(start, end)
    .replace(/^const download = /, "")
    .trim()
    .replace(/;$/, "");
  const restartStart = source.indexOf("return async (client, restartMarker) => {");
  const restartBody = source
    .slice(restartStart, source.lastIndexOf("\n}"))
    .replace(/^return /, "")
    .trim()
    .replace(/;$/, "");
  const bytes = Buffer.from("owned-audio");
  const primary = new Error(secret);
  let failRead = false,
    oldMarker;
  const actions = [];
  const click = async () => {
    actions.push("click");
  };
  const preview = {
    async waitFor() {
      actions.push("preview");
    },
    getByRole() {
      return { click };
    },
  };
  const client = {
    page: {
      getByRole(role) {
        return role === "region" ? preview : { click };
      },
      waitForEvent() {
        actions.push("save");
        return Promise.resolve({
          async path() {
            return "owned-audio";
          },
        });
      },
    },
    async call(method, params) {
      if (method === "storage.getSnapshot")
        return { value: { interviewDraft: { answer: "原始回答\nfixture" } } };
      return params.id === "done"
        ? { status: "succeeded", result: { text: "fixture" } }
        : { status: "cancelled" };
    },
  };
  const download = runInNewContext(`(${downloadBody})`, {
    practice: async () => ({ locator: () => ({ getByRole: () => ({ click }) }) }),
    refresh: async () => {
      actions.push("refresh");
    },
    succeeded: { id: "done" },
    bytes,
    assert,
    readFile: async () => {
      if (failRead) throw primary;
      return bytes;
    },
  });
  await withJobHuntBrowserDiagnostics(
    async (mark) => {
      oldMarker = mark;
      await download(client, mark);
    },
    async () => {},
    async () => {},
  );
  expect(oldMarker("audio-close-interview")).toBe(false);
  const restart = runInNewContext(`(${restartBody})`, {
    download,
    succeeded: { id: "done" },
    running: { id: "cancel" },
    transcript: "fixture",
    readRequests: async () => [1, 2],
    assert,
    console: { log() {} },
    markStep: oldMarker,
  });
  failRead = true;
  const failure = await caught(
    async (mark) => {
      await restart(client, mark);
    },
    async () => {},
    async () => {},
  );
  expect(failure).toBe(primary);
  expect(summarizeFailure(failure).jobBrowser.primaryStep).toBe("audio-download-read-assert");
  expect(oldMarker("page-errors")).toBe(false);
  expect(actions.filter((action) => action === "save")).toHaveLength(2);
});
