import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freezeDataset, readFrozenDataset, type DatasetManifest } from "./dataset.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-lab-loader-"));
  roots.push(root);
  const result = freezeDataset(
    {
      schemaVersion: 1,
      title: "Frozen samples",
      taskFamily: "text",
      cases: ["d", "h1", "h2", "h3"].map((id, index) => ({
        id,
        version: 1,
        sourceGroupId: id,
        provenance: "synthetic",
        caseRole: "regression",
        split: index === 0 ? "dev" : "holdout",
        input: `Answer ${id}`,
        hardAssertions: [{ id: "ok", kind: "contains", value: id }],
        readiness: "runnable",
      })),
    },
    root,
  );
  if (!result.ok) throw new Error("invalid test fixture");
  return { root, ...result };
}

test("verified loader recomputes frozen content, summary and case hashes", () => {
  const f = setup();
  expect(readFrozenDataset(f.root, f.manifest.datasetHash)).toEqual(f.manifest);
  const mutations: ((manifest: DatasetManifest) => void)[] = [
    (manifest) => {
      manifest.cases[0].input = "Different input";
    },
    (manifest) => {
      manifest.summary.runnableDev += 1;
    },
    (manifest) => {
      manifest.caseHashes.d = "a".repeat(64);
    },
    (manifest) => {
      manifest.cases.reverse();
    },
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(f.manifest);
    mutate(manifest);
    writeFileSync(f.path, JSON.stringify(manifest));
    expect(() => readFrozenDataset(f.root, f.manifest.datasetHash)).toThrow("integrity");
  }
});
test("verified loader refuses traversal, missing content, symlink file or directory", () => {
  const f = setup();
  expect(() => readFrozenDataset(f.root, "../outside")).toThrow();
  expect(() => readFrozenDataset(f.root, "0".repeat(64))).toThrow();
  const text = readFileSync(f.path, "utf8");
  const target = join(f.root, "copy.json");
  writeFileSync(target, text);
  rmSync(f.path);
  symlinkSync(target, f.path);
  expect(() => readFrozenDataset(f.root, f.manifest.datasetHash)).toThrow("unsafe");
  rmSync(dirname(f.path), { recursive: true });
  symlinkSync(f.root, dirname(f.path));
  expect(() => readFrozenDataset(f.root, f.manifest.datasetHash)).toThrow("unsafe dataset");
});
