import { equal } from "node:assert/strict";
import { test } from "node:test";
import { ciVerdict } from "./require-green-ci.mjs";

const run = (fields) => ({ head_sha: "abc", event: "push", status: "completed", ...fields });

test("a successful push or manual run of the commit is green, even after a failed one", () => {
  equal(
    ciVerdict([run({ conclusion: "failure" }), run({ conclusion: "success" })], "abc"),
    "green",
  );
  equal(ciVerdict([run({ event: "workflow_dispatch", conclusion: "success" })], "abc"), "green");
});

test("queued, running or not yet started CI is waited for", () => {
  equal(ciVerdict([], "abc"), "pending");
  equal(
    ciVerdict([run({ conclusion: "failure" }), run({ status: "in_progress" })], "abc"),
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
