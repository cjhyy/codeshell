import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPTIMIZATION_LAB_QUERIES } from "./queries.js";
import { labRoot } from "./store-paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "optlab-queries-"));
  roots.push(labRoot(cwd), cwd);
  return cwd;
}

const dataset = {
  schemaVersion: 1,
  title: "Report sourcing",
  taskFamily: "report-sourcing",
  cases: ["d1", "h1", "h2", "h3"].map((id) => ({
    id,
    version: 1,
    sourceGroupId: id,
    provenance: "synthetic",
    caseRole: id === "d1" ? "regression" : "target_failure",
    split: id.startsWith("d") ? "dev" : "holdout",
    input: `Summarize source ${id}`,
    hardAssertions: [{ id: "cites", kind: "contains", value: "[S1]" }],
    readiness: "runnable",
  })),
};

const validate = OPTIMIZATION_LAB_QUERIES.optimization_lab_validate_dataset!;
const freeze = OPTIMIZATION_LAB_QUERIES.optimization_lab_freeze_dataset!;

describe("optimization lab queries", () => {
  test("validate never writes to disk", async () => {
    const cwd = project();
    const result = (await validate({
      type: "optimization_lab_validate_dataset",
      cwd,
      dataset,
    })) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    expect(existsSync(labRoot(cwd))).toBe(false);
  });

  test("freeze writes one immutable manifest and is idempotent", async () => {
    const cwd = project();
    const first = (await freeze({ type: "optimization_lab_freeze_dataset", cwd, dataset })) as {
      ok: true;
      created: boolean;
      path: string;
      manifest: { datasetHash: string; frozenAt: string; cases: { id: string }[] };
    };
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(first.manifest.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.path.endsWith(join("datasets", first.manifest.datasetHash, "manifest.json"))).toBe(
      true,
    );
    expect(existsSync(first.path)).toBe(true);
    expect(first.manifest.cases.map((item) => item.id)).toEqual(["d1", "h1", "h2", "h3"]);

    const reordered = { ...dataset, cases: [...dataset.cases].reverse() };
    const second = (await freeze({
      type: "optimization_lab_freeze_dataset",
      cwd,
      dataset: reordered,
    })) as typeof first;
    expect(second.created).toBe(false);
    expect(second.manifest.datasetHash).toBe(first.manifest.datasetHash);
    expect(second.manifest.frozenAt).toBe(first.manifest.frozenAt);
    expect(JSON.parse(readFileSync(first.path, "utf8")).frozenAt).toBe(first.manifest.frozenAt);
  });

  test("freeze refuses an invalid dataset without writing", async () => {
    const cwd = project();
    const result = (await freeze({
      type: "optimization_lab_freeze_dataset",
      cwd,
      dataset: { ...dataset, cases: [] },
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(existsSync(labRoot(cwd))).toBe(false);
  });

  test("freeze requires a cwd", async () => {
    await expect(
      Promise.resolve().then(() => freeze({ type: "optimization_lab_freeze_dataset", dataset })),
    ).rejects.toThrow("cwd is required");
  });
});
