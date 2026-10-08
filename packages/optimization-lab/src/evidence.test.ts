import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildEvidenceBundle,
  importEvidenceBundle,
  verifyEvidenceBundle,
  verifyEvidenceReferences,
} from "./evidence.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
test("redaction precedes preview/hash, preserves loss, and import creates no answer key", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-evidence-"));
  roots.push(root);
  const bundle = buildEvidenceBundle("a".repeat(16), [
    {
      runId: "run-1",
      sessionId: null,
      source: "managed_run",
      truncated: true,
      missingEvidence: ["Trace tail lost"],
      blocks: [
        {
          kind: "input",
          eventId: null,
          text: 'Summarize Authorization: Bearer top-secret-value\n{"api_key":"keep-this-secret"}\nsk-proj-abcdefghijklmnopqrstuv\nhttps://user:pass@example.test/?token=confidential',
        },
        { kind: "tool", eventId: "tool-1", text: "x".repeat(40000) },
        { kind: "output", eventId: "result-1", text: "Wrong historical answer" },
      ],
    },
  ]);
  const json = JSON.stringify(bundle);
  for (const secret of [
    "top-secret-value",
    "keep-this-secret",
    "abcdefghijklmnopqrstuv",
    "user:pass",
    "confidential",
  ])
    expect(json).not.toContain(secret);
  expect(bundle.runs[0]!.blocks.find((block) => block.kind === "tool")!.truncated).toBe(true);
  const imported = importEvidenceBundle(root, "a".repeat(16), bundle);
  expect(imported.cases[0]!.readiness).toBe("analysis_only");
  expect(imported.cases[0]!.expected).toBeUndefined();
  expect(imported.cases[0]!.evidence!.bundleHash).toBe(bundle.bundleHash);
  expect(JSON.stringify(imported.cases)).not.toContain("Wrong historical answer");
  expect(
    JSON.parse(readFileSync(join(root, "evidence", `${bundle.bundleHash}.json`), "utf8")),
  ).toEqual(bundle);
  expect(importEvidenceBundle(root, "a".repeat(16), bundle)).toEqual(imported);
  verifyEvidenceReferences(root, "a".repeat(16), imported.cases);
  expect(() =>
    verifyEvidenceReferences(root, "a".repeat(16), [
      { ...imported.cases[0]!, sourceGroupId: "relabel-to-leak-holdout" },
    ]),
  ).toThrow("provenance");
  expect(() =>
    verifyEvidenceReferences(root, "a".repeat(16), [
      { ...imported.cases[0]!, evidence: { ...imported.cases[0]!.evidence!, blockHashes: [] } },
    ]),
  ).toThrow("provenance");

  expect(() => importEvidenceBundle(root, "b".repeat(16), bundle)).toThrow("project");
  const changed = structuredClone(bundle);
  changed.runs[0]!.blocks[0]!.text = "changed";
  expect(() => verifyEvidenceBundle(changed)).toThrow("identity");
});
