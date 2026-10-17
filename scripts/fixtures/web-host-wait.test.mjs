import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "./web-host-operations.mjs";

test("a never-settling asynchronous predicate remains bounded", async () => {
  const started = Date.now();
  await assert.rejects(
    waitFor(() => new Promise(() => {}), "owned pending read", 30),
    /Timed out: owned pending read/,
  );
  assert(Date.now() - started < 1000);
});

test("an asynchronous predicate rejection is preserved", async () => {
  const failure = new Error("owned read rejection");
  await assert.rejects(
    waitFor(
      async () => {
        throw failure;
      },
      "owned read",
      500,
    ),
    (error) => error === failure,
  );
});

test("asynchronous false results are polled until the actual true result", async () => {
  let checks = 0;
  const result = await waitFor(
    async () => {
      await new Promise((done) => setTimeout(done, 10));
      return ++checks === 3 ? "owned ready" : false;
    },
    "owned recovery",
    500,
  );
  assert.equal(result, "owned ready");
  assert.equal(checks, 3);
});
