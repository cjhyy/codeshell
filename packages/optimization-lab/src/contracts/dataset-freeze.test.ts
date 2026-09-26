import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DATASET_BYTES,
  freezeDataset,
  validateDataset,
  type DatasetManifest,
} from "./dataset.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), "optlab-freeze-"));
  roots.push(root);
  return root;
};
const dataset = () => ({
  schemaVersion: 1,
  title: "Report sourcing",
  taskFamily: "report-sourcing",
  cases: ["a-b", "a.b", "a_b", "constructor", "h2", "h3"].map((id, index) => ({
    id,
    version: 1,
    sourceGroupId: id,
    provenance: "synthetic",
    caseRole: index === 0 ? "regression" : "target_failure",
    split: index < 3 ? "dev" : "holdout",
    input: `Summarize source ${id}`,
    hardAssertions: [{ id: "cites", kind: "contains", value: "[S1]" }],
    readiness: "runnable",
  })),
});
const freeze = (root: string) => {
  const result = freezeDataset(dataset(), root, () => new Date("2026-09-26T00:00:00.000Z"));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
};

describe("freezeDataset", () => {
  test("sorts ids by code units and preserves constructor as an own hash key", () => {
    const result = freeze(directory());
    expect(result.manifest.cases.map((item) => item.id)).toEqual([
      "a-b",
      "a.b",
      "a_b",
      "constructor",
      "h2",
      "h3",
    ]);
    expect(Object.hasOwn(result.manifest.caseHashes, "constructor")).toBe(true);
    expect(result.manifest.caseHashes.constructor).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(result.manifest);
  });

  test("reuses exact stored bytes and never evaluates a new timestamp", () => {
    const root = directory();
    const first = freeze(root);
    const before = readFileSync(first.path, "utf8");
    const stat = statSync(first.path);
    const raw = dataset();
    raw.cases.reverse();
    const second = freezeDataset(raw, root, () => {
      throw new Error("must not run");
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.manifest).toEqual(first.manifest);
    expect(readFileSync(first.path, "utf8")).toBe(before);
    expect(statSync(first.path).mtimeMs).toBe(stat.mtimeMs);
  });

  test("a content change creates a separate immutable version", () => {
    const root = directory();
    const first = freeze(root);
    const raw = dataset();
    raw.cases[0]!.input += " Changed.";
    const second = freezeDataset(raw, root);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(true);
    expect(second.manifest.datasetHash).not.toBe(first.manifest.datasetHash);
    expect(existsSync(first.path)).toBe(true);
  });

  const corruptions: [string, (manifest: DatasetManifest) => unknown][] = [
    [
      "content",
      (m) => {
        m.cases[0]!.input += " altered";
        return m;
      },
    ],
    [
      "declared hash",
      (m) => {
        m.datasetHash = "a".repeat(64);
        return m;
      },
    ],
    [
      "case hash",
      (m) => {
        m.caseHashes["a-b"] = "a".repeat(64);
        return m;
      },
    ],
    [
      "missing case hash",
      (m) => {
        delete m.caseHashes["a-b"];
        return m;
      },
    ],
    [
      "summary",
      (m) => {
        m.summary.runnableDev += 1;
        return m;
      },
    ],
    [
      "case order",
      (m) => {
        m.cases.reverse();
        return m;
      },
    ],
    [
      "timestamp",
      (m) => {
        m.frozenAt = "yesterday";
        return m;
      },
    ],
    [
      "policy",
      (m) => {
        m.verdictPolicySuiteVersion = "other";
        return m;
      },
    ],
    ["unknown field", (m) => ({ ...m, extra: true })],
    [
      "missing normalized field",
      (m) => {
        delete (m.cases[0] as unknown as Record<string, unknown>).fixtureRefs;
        return m;
      },
    ],
    ["null", () => null],
  ];
  test.each(corruptions)(
    "rejects a manifest with altered %s without overwriting it",
    (_name, corrupt) => {
      const root = directory();
      const first = freeze(root);
      const invalid = JSON.stringify(corrupt(first.manifest));
      writeFileSync(first.path, invalid);
      expect(() => freeze(root)).toThrow("manifest");
      expect(readFileSync(first.path, "utf8")).toBe(invalid);
    },
  );

  test("rejects truncated JSON and a symlinked manifest without repairing either", () => {
    const root = directory();
    const first = freeze(root);
    writeFileSync(first.path, '{"schemaVersion":');
    expect(() => freeze(root)).toThrow();
    expect(readFileSync(first.path, "utf8")).toBe('{"schemaVersion":');
    const target = join(root, "outside.json");
    writeFileSync(target, JSON.stringify(first.manifest));
    rmSync(first.path);
    symlinkSync(target, first.path);
    expect(() => freeze(root)).toThrow("bounded regular file");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(first.manifest);
  });

  test("concurrent processes freeze one manifest and agree on the winning timestamp", async () => {
    const root = directory();
    const modulePath = join(import.meta.dir, "dataset.ts");
    const processes = Array.from({ length: 6 }, (_, index) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { freezeDataset } from ${JSON.stringify(modulePath)};
        const result = freezeDataset(${JSON.stringify(dataset())}, ${JSON.stringify(root)},
          () => new Date(${JSON.stringify(`2026-09-26T00:00:0${index}.000Z`)}));
        console.log(JSON.stringify(result));
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const results = await Promise.all(
      processes.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        return JSON.parse(stdout) as ReturnType<typeof freeze>;
      }),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.manifest.frozenAt)).size).toBe(1);
    expect(new Set(results.map((result) => result.manifest.datasetHash)).size).toBe(1);
    expect(JSON.parse(readFileSync(results[0]!.path, "utf8"))).toEqual(results[0]!.manifest);
  });
});

test("rejects a manifest over the byte budget before creating any lab directory", () => {
  const root = join(directory(), "not-created");
  const raw = dataset();
  raw.cases = Array.from({ length: 128 }, (_, index) => ({
    ...raw.cases[0]!,
    id: `case-${index}`,
    sourceGroupId: `group-${index}`,
    split: index < 64 ? "dev" : "holdout",
    input: `${index}:`.padEnd(65536, "x"),
    expected: "x".repeat(65000),
  }));
  // Tune the final expected text to leave less room than manifest metadata and
  // indentation require, while keeping the normalized dataset below the cap.
  const validation = validateDataset(raw);
  expect(validation.ok).toBe(true);
  const before = Buffer.byteLength(JSON.stringify(validation.dataset));
  let padding = MAX_DATASET_BYTES - before - 32;
  for (const item of raw.cases as ((typeof raw.cases)[number] & { expected: string })[]) {
    if (padding > 0) {
      const amount = Math.min(padding, 65536 - item.expected.length);
      item.expected += "x".repeat(amount);
      padding -= amount;
    }
  }
  expect(validateDataset(raw).ok).toBe(true);
  const result = freezeDataset(raw, root);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.code)).toContain("dataset_too_large");
  expect(existsSync(root)).toBe(false);
});
