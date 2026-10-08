import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunTestCompletion, createBunTestEnvironment } from "./bun-test-completion.mjs";

const directory = mkdtempSync(join(tmpdir(), "codeshell-bun-completion-test-"));
const wrapper = fileURLToPath(new URL("./run-bun-test-shard.mjs", import.meta.url));
try {
  const environment = createBunTestEnvironment(
    {
      PATH: process.env.PATH,
      CI: "true",
      CHROME_PATH: "/fixture/chrome",
      CODESHELL_TEST_CHROMIUM: "/fixture/chromium",
      HOME: "/operator/home",
      USERPROFILE: "/operator/home",
      CODE_SHELL_HOME: "/operator/state",
      CODE_SHELL_CAPABILITY_MODULES: "operator-module",
      CODESHELL_COST_SMOKE_ORIGIN: "https://operator.example",
      OPENAI_API_KEY: "synthetic-parent-secret",
      CUSTOM_PROVIDER_TOKEN: "synthetic-parent-token",
      OPERATOR_CUSTOM_AUTH: "synthetic-parent-auth",
      HTTPS_PROXY: "https://operator.example",
      NODE_OPTIONS: "--require operator-preload",
      SSH_AUTH_SOCK: "/operator/agent",
    },
    join(directory, "environment-check"),
  );
  assert.equal(environment.CI, "true");
  assert.equal(environment.PATH, process.env.PATH);
  assert.equal(environment.CHROME_PATH, "/fixture/chrome");
  assert.equal(environment.CODESHELL_TEST_CHROMIUM, "/fixture/chromium");
  assert.equal(environment.HOME, environment.USERPROFILE);
  assert.ok(environment.HOME.startsWith(realpathSync(directory)));
  assert.equal(environment.CODE_SHELL_HOME, join(environment.HOME, ".code-shell"));
  for (const key of [
    "CODE_SHELL_CAPABILITY_MODULES",
    "CODESHELL_COST_SMOKE_ORIGIN",
    "OPENAI_API_KEY",
    "CUSTOM_PROVIDER_TOKEN",
    "OPERATOR_CUSTOM_AUTH",
    "HTTPS_PROXY",
    "NODE_OPTIONS",
    "SSH_AUTH_SOCK",
  ])
    assert.equal(environment[key], undefined);
  console.log("✓ Bun completion: private HOME and inherited credentials isolated");
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
    [
      "environment",
      'test("private child environment", () => { expect(process.env.HOME).toBe(process.env.USERPROFILE); expect(process.env.CODE_SHELL_HOME).toBe(join(process.env.HOME!, ".code-shell")); expect(process.env.OPENAI_API_KEY).toBeUndefined(); expect(process.env.CUSTOM_PROVIDER_TOKEN).toBeUndefined(); expect(process.env.OPERATOR_CUSTOM_AUTH).toBeUndefined(); expect(process.env.CODE_SHELL_CAPABILITY_MODULES).toBeUndefined(); expect(process.env.HTTPS_PROXY).toBeUndefined(); });',
      true,
    ],
  ];
  for (const [name, body, succeeds] of cases) {
    const fixture = join(directory, `${name}.test.ts`);
    writeFileSync(
      fixture,
      `import { test, expect, afterAll, describe } from "bun:test";\nimport { join } from "node:path";\nconsole.log("FIXTURE_CHILD_HOME=" + JSON.stringify(process.env.HOME));\n${body}`,
    );
    const entry = name === "pass" && process.platform !== "win32" ? alias : wrapper;
    const result = spawnSync(process.execPath, [entry, "--timeout", "30000", fixture], {
      encoding: "utf8",
      timeout: 35_000,
      env: {
        ...process.env,
        OPENAI_API_KEY: "synthetic-parent-secret",
        CUSTOM_PROVIDER_TOKEN: "synthetic-parent-token",
        OPERATOR_CUSTOM_AUTH: "synthetic-parent-auth",
        CODE_SHELL_CAPABILITY_MODULES: "operator-module",
        HTTPS_PROXY: "https://operator.example",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, succeeds, `${name}: ${result.stdout}\n${result.stderr}`);
    const childHome = JSON.parse(result.stdout.match(/FIXTURE_CHILD_HOME=([^\r\n]+)/)[1]);
    assert.notEqual(childHome, process.env.HOME);
    assert.equal(existsSync(childHome), false, `${name}: private HOME must be cleaned up`);
    if (name === "pass")
      assert.match(result.stdout, /Completed Bun shard: 3 tests, 1 skipped; 0 failures/);
    if (name === "environment")
      assert.match(result.stdout, /Completed Bun shard: 1 tests, 0 skipped; 0 failures/);
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
