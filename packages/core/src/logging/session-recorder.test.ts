import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function record(env: Record<string, string | undefined>, args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-model-recording-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  copyFileSync(
    new URL("./session-recorder.ts", import.meta.url),
    join(root, "session-recorder.ts"),
  );
  const runner = join(root, "record.ts");
  writeFileSync(
    runner,
    `
    import { recordLLMRequest, recordLLMResponse, recordLLMError, getVerboseLogDir } from "./session-recorder.ts";
    recordLLMRequest("test-session", {
      provider: "test-provider", model: "test-model", stream: true,
      systemPrompt: "PRIVATE_SYSTEM_CONTENT",
      messages: [{ role: "user", content: "PRIVATE_USER_CONTENT" }],
      tools: [{ name: "tool", description: "PRIVATE_TOOL_SCHEMA" }],
    }, "test-request");
    recordLLMResponse("test-session", {
      text: "PRIVATE_RESPONSE_CONTENT",
      toolCalls: [{ id: "tool-1", toolName: "tool", args: { secret: "PRIVATE_TOOL_ARGS" } }],
      durationMs: 10,
    }, "test-request");
    recordLLMError("test-session", "test-request", new Error("PRIVATE_ERROR_CONTENT"), 10);
    console.log(getVerboseLogDir());
  `,
  );
  const child = spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CODE_SHELL_DEV: "0",
      CODE_SHELL_VERBOSE_LOG: "1",
      CODE_SHELL_RECORD_MODEL_CONTENT: undefined,
      ...env,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  const logRoot = child.stdout.trim();
  if (!logRoot) return [];
  const [day] = readdirSync(logRoot);
  return readFileSync(join(logRoot, day!, "engine/session-test-session.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test.each([
  ["local dev", { CODE_SHELL_DEV: "1" }, []],
  ["debug", {}, ["--debug"]],
  [
    "unrecognized opt-in value",
    { CODE_SHELL_DEV: "1", CODE_SHELL_RECORD_MODEL_CONTENT: "true" },
    [],
  ],
] as const)("%s writes model metadata without implicit sensitive contents", (_label, env, args) => {
  const records = record(env, [...args]);
  expect(records.map((item) => item.type)).toEqual(["llm.request", "llm.response", "llm.error"]);
  expect(
    records.every((item) => item.reqId === "test-request" && item.contentRecorded === false),
  ).toBe(true);
  expect(records[0]).toMatchObject({
    provider: "test-provider",
    model: "test-model",
    toolCount: 1,
    messageCount: 1,
  });
  expect(records[1]).toMatchObject({ toolCallCount: 1, durationMs: 10 });
  expect(JSON.stringify(records)).not.toContain("PRIVATE_");
});

test("explicit opt-in in a dev run records the declared model content scope", () => {
  const records = record({ CODE_SHELL_DEV: "1", CODE_SHELL_RECORD_MODEL_CONTENT: "1" });
  expect(records.every((item) => item.contentRecorded === true)).toBe(true);
  expect(records[0].systemPrompt).toBe("PRIVATE_SYSTEM_CONTENT");
  expect(records[0].messages[0].content).toBe("PRIVATE_USER_CONTENT");
  expect(records[0].tools[0].description).toBe("PRIVATE_TOOL_SCHEMA");
  expect(records[1].text).toBe("PRIVATE_RESPONSE_CONTENT");
  expect(records[1].toolCalls[0].args.secret).toBe("PRIVATE_TOOL_ARGS");
  expect(records[2].message).toBe("PRIVATE_ERROR_CONTENT");
});

test("the content switch does not enable the recorder or override its off switch", () => {
  expect(record({ CODE_SHELL_RECORD_MODEL_CONTENT: "1" })).toEqual([]);
  expect(
    record({
      CODE_SHELL_DEV: "1",
      CODE_SHELL_RECORD_MODEL_CONTENT: "1",
      CODE_SHELL_VERBOSE_LOG: "0",
    }),
  ).toEqual([]);
});
