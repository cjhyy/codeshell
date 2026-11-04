import { equal } from "node:assert/strict";
import { test } from "node:test";
import { ciVerdict, fetchCiRuns } from "./require-green-ci.mjs";

const run = (fields) => ({ head_sha: "abc", event: "push", status: "completed", ...fields });

test("a newer failure supersedes an older successful run", () => {
  equal(ciVerdict([run({ conclusion: "failure" }), run({ conclusion: "success" })], "abc"), "red");
  equal(ciVerdict([run({ event: "workflow_dispatch", conclusion: "success" })], "abc"), "green");
});

test("queued, running or not yet started CI is waited for", () => {
  equal(ciVerdict([], "abc"), "pending");
  equal(
    ciVerdict([run({ status: "in_progress" }), run({ conclusion: "success" })], "abc"),
    "pending",
  );
});

test("only failures, or success on another commit or a pull request merge, are red", () => {
  equal(
    ciVerdict([run({ conclusion: "failure" }), run({ conclusion: "cancelled" })], "abc"),
    "red",
  );
  // Neither of these ran this exact commit on main.
  equal(ciVerdict([run({ head_sha: "other", conclusion: "success" })], "abc"), "pending");
  equal(
    ciVerdict(
      [run({ conclusion: "failure" }), run({ event: "pull_request", conclusion: "success" })],
      "abc",
    ),
    "red",
  );
});

test("transient API failures retry with bounded backoff", async () => {
  let calls = 0;
  const waits = [];
  const response = await fetchCiRuns(
    "https://fixture.invalid",
    {},
    async () => {
      calls++;
      return new Response("{}", { status: calls < 3 ? 503 : 200 });
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  equal(response.status, 200);
  equal(calls, 3);
  equal(waits.join(","), "1000,2000");
});
