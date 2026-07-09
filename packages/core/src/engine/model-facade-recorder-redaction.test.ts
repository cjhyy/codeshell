import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  delete env.BUN_TEST;
  delete env.NODE_ENV;
  env.CODE_SHELL_DEV = "1";
  env.CODE_SHELL_VERBOSE_LOG = "1";
  env.CODE_SHELL_LOG = "0";
  return env;
}

function findSessionRecorderFile(root: string, sid: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const stack = [root];
  const fileName = `session-${sid}.jsonl`;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (entry === fileName) {
        return full;
      }
    }
  }
  return undefined;
}

async function expectRecorderRedactionFor(method: "call" | "callWithoutStreaming"): Promise<void> {
  const sid = `recorder-redaction-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const apiKeySecret = "sk-recorder-redaction-secret";
  const tokenSecret = "token-recorder-redaction-secret";
  const secret = JSON.stringify({ apiKey: apiKeySecret, token: tokenSecret });
  const apiKeyPlaceholder = "[api key withheld]";
  const tokenPlaceholder = "[token withheld]";
  const redacted = JSON.stringify({ apiKey: apiKeyPlaceholder, token: tokenPlaceholder });
  const invocation =
    method === "call"
      ? `
      await facade.call(
        "system",
        messages,
        [],
        undefined,
        undefined,
        recordingOptions,
      );
    `
      : `
      await facade.callWithoutStreaming(
        "system",
        messages,
        [],
        undefined,
        recordingOptions,
      );
    `;
  const script = `
      import { ModelFacade } from "./packages/core/src/engine/model-facade.ts";
      import { setCurrentSid } from "./packages/core/src/logging/logger.ts";
      import { getVerboseLogDir } from "./packages/core/src/logging/session-recorder.ts";

      const sid = ${JSON.stringify(sid)};
      const secret = ${JSON.stringify(secret)};
      const apiKeySecret = ${JSON.stringify(apiKeySecret)};
      const tokenSecret = ${JSON.stringify(tokenSecret)};
      let providerSawSecret = false;
      setCurrentSid(sid);

      const client = {
        provider: "stub",
        model: "stub-model",
        async createMessage(options) {
          const serialized = JSON.stringify(options.messages);
          providerSawSecret =
            serialized.includes(apiKeySecret) && serialized.includes(tokenSecret);
          return {
            text: "ok",
            toolCalls: [],
            stopReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
        getUsage() {
          return {
            records: [],
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalTokens: 0,
            requestCount: 0,
          };
        },
      };
      const transcript = { appendMessage() {} };
      const facade = new ModelFacade(client, transcript);
      const messages = [
        { role: "assistant", content: [{ type: "tool_use", id: "cred", name: "UseCredential", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "cred", content: secret }] },
      ];
      const recordingOptions = {
        sensitiveToolResultRedactions: new Map([["cred", ${JSON.stringify(redacted)}]]),
      };
      ${invocation}
      console.log(JSON.stringify({ sid, logDir: getVerboseLogDir(), providerSawSecret }));
    `;

  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot(),
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const lastLine = stdout.trim().split(/\n/).filter(Boolean).at(-1);
  expect(lastLine).toBeDefined();
  const result = JSON.parse(lastLine!) as {
    sid: string;
    logDir: string;
    providerSawSecret: boolean;
  };
  expect(result.providerSawSecret).toBe(true);

  const recorderFile = findSessionRecorderFile(result.logDir, result.sid);
  expect(recorderFile).toBeDefined();
  const recorded = readFileSync(recorderFile!, "utf8");
  rmSync(recorderFile!, { force: true });

  expect(recorded).toContain('"type":"llm.request"');
  expect(recorded).toContain(apiKeyPlaceholder);
  expect(recorded).toContain(tokenPlaceholder);
  expect(recorded).not.toContain(apiKeySecret);
  expect(recorded).not.toContain(tokenSecret);
}

describe("ModelFacade recorder redaction", () => {
  test("records sensitive tool_result key/token placeholders for streaming calls while provider receives plaintext", async () => {
    await expectRecorderRedactionFor("call");
  });

  test("records sensitive tool_result key/token placeholders for non-streaming calls while provider receives plaintext", async () => {
    await expectRecorderRedactionFor("callWithoutStreaming");
  });
});
