import { expect, test } from "bun:test";
import { validateCandidates } from "./candidate.js";
import { overfitHints } from "./overfit-hints.js";
const options = {
  parentBodyHash: "a".repeat(64),
  frontmatterOriginal: "---\nname: private\n---\n",
  devCaseIds: ["dev"],
  maxCandidates: 2,
  maxBodyBytes: 100,
  maxContextBytes: 1000,
};
const proposal = (body: string, sourceCaseIds = ["dev"]) =>
  JSON.stringify({ candidates: [{ body, explanation: "fix", sourceCaseIds }] });
test("candidate preserves original metadata and never changes sources", () => {
  const [item] = validateCandidates(proposal("New instructions"), options);
  expect(item?.markdown).toBe(options.frontmatterOriginal + "New instructions");
  expect(() => validateCandidates(proposal("---\nname: evil"), options)).toThrow();
  expect(() => validateCandidates(proposal("New instructions", ["holdout"]), options)).toThrow();
  expect(() => validateCandidates(proposal("x".repeat(101)), options)).toThrow();
});
test("overfit hints are deterministic and advisory", () => {
  expect(overfitHints("Be useful", "Repeat Acme 302 report.csv", ["Acme 302 report.csv"])).toEqual(
    overfitHints("Be useful", "Repeat Acme 302 report.csv", ["Acme 302 report.csv"]),
  );
  expect(
    overfitHints("Be useful", "Repeat Acme 302 report.csv", ["Acme 302 report.csv"]).length,
  ).toBeGreaterThan(0);
});
