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

describe("ModelFacade recorder redaction", () => {
  test("records sensitive tool_result placeholders while provider receives plaintext", async () => {
    const sid = `recorder-redaction-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const secret = "credential-secret-that-must-not-hit-recorder";
    const placeholder = "[credential value withheld]";
    const redacted = JSON.stringify({ kind: "value", value: placeholder });
    const script = `
      import { ModelFacade } from "./packages/core/src/engine/model-facade.ts";
      import { setCurrentSid } from "./packages/core/src/logging/logger.ts";
      import { getVerboseLogDir } from "./packages/core/src/logging/session-recorder.ts";

      const sid = ${JSON.stringify(sid)};
      const secret = ${JSON.stringify(secret)};
      let providerSawSecret = false;
      setCurrentSid(sid);

      const client = {
        provider: "stub",
        model: "stub-model",
        async createMessage(options) {
          providerSawSecret = JSON.stringify(options.messages).includes(secret);
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
      await facade.call(
        "system",
        [
          { role: "assistant", content: [{ type: "tool_use", id: "cred", name: "UseCredential", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "cred", content: secret }] },
        ],
        [],
        undefined,
        undefined,
        { sensitiveToolResultRedactions: new Map([["cred", ${JSON.stringify(redacted)}]]) },
      );
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
    expect(recorded).toContain(placeholder);
    expect(recorded).not.toContain(secret);
  });
});
