import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeTextInference, type ClaudeTextInferenceOptions } from "./text-inference.js";

let root: string;
const fixture = fileURLToPath(new URL("./fixtures/text-inference-cli.mjs", import.meta.url));
const dependencies = {
  spawn: ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    expect(command).toBe("fixture-claude");
    return spawn(process.execPath, [fixture, ...args], options);
  }) as typeof spawn,
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-text-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function options(mode = "success", fields: Partial<ClaudeTextInferenceOptions> = {}) {
  return {
    systemPrompt: "Only extract durable memory as JSON.",
    userMessage: "PRIVATE_TRANSCRIPT_BODY: the latest decision is local integration only.",
    model: "fixture-model",
    command: "fixture-claude",
    env: {
      ...process.env,
      CODESHELL_TEST_CLAUDE_MODE: mode,
      CODESHELL_TEST_CLAUDE_REPORT: join(root, "report.json"),
      CODESHELL_TEST_AUTH_MARKER: "same-account-fixture",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "parent-fixture",
      CLAUDE_CODE_SIMPLE: "1",
      CODESHELL_CODEX_MCP_TOKEN: "fixture-bridge-token",
      CODE_SHELL_HOST_MCP_SERVERS: "fixture-host-config",
      CODESHELL_MODEL_TRACE_FD: "3",
    },
    ...fields,
  } satisfies ClaudeTextInferenceOptions;
}
const report = () => JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
async function waitForReport() {
  const deadline = Date.now() + 5000;
  while (!existsSync(join(root, "report.json"))) {
    if (Date.now() >= deadline) throw new Error("fixture did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return report();
}
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("uses a fresh tool-less CLI, private prompt file and stdin with the selected model/account", async () => {
  const input = options("success", { maxTokens: 4096 });
  expect(await runClaudeTextInference(input, dependencies)).toEqual({
    text: "最近的结论 🙂",
    stopReason: "end_turn",
    usage: {
      promptTokens: 15,
      completionTokens: 11,
      totalTokens: 26,
      cacheReadTokens: 5,
      cacheCreationTokens: 3,
    },
  });
  const actual = report();
  expect(actual.input).toBe(input.userMessage);
  expect(actual.systemPrompt).toBe(input.systemPrompt);
  expect(actual.args).not.toContain(input.userMessage);
  expect(actual.args).not.toContain(input.systemPrompt);
  expect(actual.args).not.toContain("--resume");
  expect(actual.args).not.toContain("--continue");
  expect(actual.args).not.toContain("--mcp-config");
  expect(actual.args).not.toContain("--bare");
  for (const flag of [
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
  ])
    expect(actual.args).toContain(flag);
  for (const [flag, value] of [
    ["--tools", ""],
    ["--disallowedTools", "*"],
    ["--permission-mode", "dontAsk"],
    ["--permission-prompts", "none"],
    ["--max-turns", "1"],
    ["--model", "fixture-model"],
  ])
    expect(actual.args[actual.args.indexOf(flag) + 1]).toBe(value);
  expect(actual.authMarker).toBe("same-account-fixture");
  expect(actual.maxTokens).toBe("4096");
  expect(actual.safeMode).toBe("1");
  for (const name of [
    "nestedMarker",
    "entrypoint",
    "bareMode",
    "bridgeToken",
    "hostMcp",
    "traceFd",
  ])
    expect(actual[name]).toBeUndefined();
  expect(input.env.CLAUDECODE).toBe("1");
  if (process.platform !== "win32") expect(actual.mode).toBe(0o600);
  expect(actual.cwd).not.toBe(root);
  expect(existsSync(actual.cwd)).toBe(false);
  expect(isAlive(actual.pid)).toBe(false);
});

test.each(["success", "tool"])(
  "preserves the foreground settings boundary and private prompt cleanup for %s",
  async (mode) => {
    const cwd = join(root, "foreground");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const projectSettings = {
      env: { ANTHROPIC_BASE_URL: "https://project-provider.fixture.invalid" },
      apiKeyHelper: "./project-account-fixture",
    };
    const configPath = join(cwd, ".claude", "settings.local.json");
    const config = JSON.stringify(projectSettings);
    writeFileSync(configPath, config);
    const before = readdirSync(cwd);
    const pending = runClaudeTextInference(options(mode, { cwd }), dependencies);
    if (mode === "success") expect((await pending).text).toBe("最近的结论 🙂");
    else await expect(pending).rejects.toThrow("tools");

    const actual = report();
    const promptFile = actual.args[actual.args.indexOf("--system-prompt-file") + 1];
    expect(actual.cwd).toBe(realpathSync(cwd));
    expect(actual.projectSettings).toEqual(projectSettings);
    expect(relative(cwd, promptFile)).toStartWith("..");
    expect(existsSync(dirname(promptFile))).toBe(false);
    expect(existsSync(cwd)).toBe(true);
    expect(readdirSync(cwd)).toEqual(before);
    expect(readFileSync(configPath, "utf8")).toBe(config);
  },
);

test.each([
  ["tool", "tools"],
  ["raw-tool", "tools"],
  ["available-tools", "tools"],
  ["truncated", "complete text"],
  ["truncated-result", "complete text"],
  ["error", "incomplete or failed"],
  ["max-turns", "incomplete or failed"],
  ["empty", "incomplete or failed"],
  ["malformed", "malformed JSON"],
  ["missing", "no terminal result"],
  ["duplicate", "multiple terminal"],
  ["nonzero", "without success"],
  ["overflow", "byte limit"],
  ["stderr-overflow", "byte limit"],
])("rejects %s output and removes its temporary context", async (mode, message) => {
  await expect(runClaudeTextInference(options(mode), dependencies)).rejects.toThrow(message);
  const actual = report();
  expect(existsSync(actual.cwd)).toBe(false);
  expect(isAlive(actual.pid)).toBe(false);
});

test("a pre-aborted invocation never starts a process", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await expect(
    runClaudeTextInference(options("success", { signal: controller.signal }), {
      spawn: (() => {
        spawned = true;
        throw new Error("unexpected spawn");
      }) as typeof spawn,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(spawned).toBe(false);
  expect(existsSync(join(root, "report.json"))).toBe(false);
});

test("aborting a stubborn process waits for group termination and cleans private files", async () => {
  const controller = new AbortController();
  const pending = runClaudeTextInference(
    options("hang", { signal: controller.signal }),
    dependencies,
  );
  const rejection = pending.catch((error) => error);
  const actual = await waitForReport();
  controller.abort();
  expect(await rejection).toMatchObject({ name: "AbortError" });
  expect(isAlive(actual.pid)).toBe(false);
  expect(existsSync(actual.cwd)).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "aborting an invocation also reaps its attached descendants",
  async () => {
    const controller = new AbortController();
    const pending = runClaudeTextInference(
      options("tree", { signal: controller.signal }),
      dependencies,
    );
    const rejection = pending.catch((error) => error);
    const actual = await waitForReport();
    controller.abort();
    expect(await rejection).toMatchObject({ name: "AbortError" });
    expect(isAlive(actual.pid)).toBe(false);
    expect(isAlive(actual.childPid)).toBe(false);
    expect(existsSync(actual.cwd)).toBe(false);
  },
);

test("enforces its timeout and kills a process that ignores SIGTERM", async () => {
  await expect(
    runClaudeTextInference(options("hang", { timeoutMs: 500 }), dependencies),
  ).rejects.toThrow("timed out");
  const actual = report();
  expect(isAlive(actual.pid)).toBe(false);
  expect(existsSync(actual.cwd)).toBe(false);
});

test("a missing CLI rejects without leaving its private directory", async () => {
  let cwd: string | undefined;
  await expect(
    runClaudeTextInference(options(), {
      spawn: ((command: string, args: string[], spawnOptions: Parameters<typeof spawn>[2]) => {
        cwd = spawnOptions?.cwd as string;
        return spawn(join(root, "missing-claude"), args, spawnOptions);
      }) as typeof spawn,
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(cwd).toBeDefined();
  expect(existsSync(cwd!)).toBe(false);
});
