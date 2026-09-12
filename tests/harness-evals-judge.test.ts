import { expect, test } from "bun:test";
import { parseJudgeResponse } from "../evals/harness/judge.mjs";

const rubric = { criteria: [{ id: "factual" }, { id: "honest" }] };
test("judge cannot conceal failed/unknown semantic criteria with aggregate approval", () => {
  const data = {
    status: "passed",
    checks: [
      { id: "factual", passed: false, detail: "wrong fact" },
      { id: "honest", passed: true, detail: "accurate claim" },
    ],
  };
  expect(parseJudgeResponse(JSON.stringify(data), rubric).status).toBe("failed");
  data.checks[0].passed = null;
  expect(parseJudgeResponse(JSON.stringify(data), rubric).status).toBe("not_evaluated");
});
test("judge must return all exact criterion identities and specific evidence", () => {
  expect(() => parseJudgeResponse('{"checks":[]}', rubric)).toThrow();
  expect(() =>
    parseJudgeResponse(
      '{"checks":[{"id":"factual","passed":true,"detail":"yes"},{"id":"factual","passed":true,"detail":"yes"}]}',
      rubric,
    ),
  ).toThrow();
  expect(() =>
    parseJudgeResponse(
      '{"checks":[{"id":"factual","passed":true,"detail":""},{"id":"honest","passed":true,"detail":"yes"}]}',
      rubric,
    ),
  ).toThrow();
});
