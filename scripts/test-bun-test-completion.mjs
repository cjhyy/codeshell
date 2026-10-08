import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunTestCompletion } from "./bun-test-completion.mjs";

const directory = mkdtempSync(join(tmpdir(), "codeshell-bun-completion-test-"));
const wrapper = fileURLToPath(new URL("./run-bun-test-shard.mjs", import.meta.url));
try {
  const alias = join(directory, "entry-alias.mjs");
  if (process.platform !== "win32") symlinkSync(wrapper, alias);
  const cases = [
    [
      "pass",
      'test("passes > quoted", () => expect(1).toBe(1)); test.skip("skips", () => {}); describe("nested > group", () => { test("self /> closed", () => expect(1).toBe(1)); });',
      true,
    ],
    ["failure", 'test("fails", () => expect(1).toBe(2));', false],
    [
      "early-failure",
      'test("fails", () => expect(1).toBe(2)); afterAll(() => process.exit(0));',
      false,
    ],
    [
      "early-success",
      'test("passes", () => expect(1).toBe(1)); afterAll(() => process.exit(0));',
      false,
    ],
    ["empty", "", false],
  ];
  for (const [name, body, succeeds] of cases) {
    const fixture = join(directory, `${name}.test.ts`);
    writeFileSync(fixture, `import { test, expect, afterAll, describe } from "bun:test";\n${body}`);
    const entry = name === "pass" && process.platform !== "win32" ? alias : wrapper;
    const result = spawnSync(process.execPath, [entry, "--timeout", "30000", fixture], {
      encoding: "utf8",
      timeout: 35_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, succeeds, `${name}: ${result.stdout}\n${result.stderr}`);
    if (succeeds)
      assert.match(result.stdout, /Completed Bun shard: 3 tests, 1 skipped; 0 failures/);
    console.log(`✓ Bun completion: ${name}`);
  }
  const malformed = join(directory, "incomplete.xml");
  writeFileSync(
    malformed,
    '<testsuites tests="1" failures="0" skipped="0"><testsuite tests="1" failures="0"><testcase name="one"/>',
  );
  assert.throws(() => assertBunTestCompletion(malformed), /incomplete/);
  writeFileSync(
    malformed,
    '<testsuites tests="2" failures="0" skipped="0"><testsuite tests="1" failures="0"><testcase name="one"/></testsuite></testsuites>',
  );
  assert.throws(() => assertBunTestCompletion(malformed), /incomplete test counts/);
  writeFileSync(
    malformed,
    '<testsuites tests="1" failures="0" skipped="0"><testsuite tests="1" failures="0"><testcase name="one"/></testsuites>',
  );
  assert.throws(() => assertBunTestCompletion(malformed), /incomplete test counts/);
  writeFileSync(
    malformed,
    '<testsuites tests="1" failures="0" skipped="0" errors="invalid"><testsuite tests="1" failures="0"><testcase name="one"/></testsuite></testsuites>',
  );
  assert.throws(() => assertBunTestCompletion(malformed), /invalid errors/);
  console.log("✓ Bun completion: truncated and inconsistent reports rejected");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
