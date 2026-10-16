import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelTraceStore, withModelTraceContext } from "@cjhyy/code-shell-core/internal";
import { runAgentOnce } from "./external-agent-driver.js";
import { claudeAdapter } from "./agent-adapter.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(captureContent = true) {
  const root = mkdtempSync(join(tmpdir(), "drive-agent-trace-"));
  roots.push(root);
  const storageDir = join(root, ".model-traces");
  const store = new ModelTraceStore({ storageDir });
  store.setConfig({ captureContent });
  const script = join(root, "fixture-cli.mjs");
  writeFileSync(
    script,
    `let input=""; for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:"result",session_id:"opaque-cli-session",result:"Visible CLI reply: "+input,is_error:false}));`,
  );
  const adapter = { ...claudeAdapter, buildArgs: () => [script], promptViaStdin: true };
  const run = (command = process.execPath) =>
    withModelTraceContext(
      {
        storageDir,
        workspacePath: root,
        sessionId: "native-owner",
        runId: "native-run",
        ephemeral: false,
      },
      () => runAgentOnce(adapter, { command, cwd: root, prompt: "actual delegated request" }),
    );
  return { root, store, run };
}

test("delegated CLI invocation records submitted stdin and visible final output under its native owner, never private wire", async () => {
  const { root, store, run } = fixture();
  const result = await run();
  expect(result.finalText).toBe("Visible CLI reply: actual delegated request");
  expect(store.list().total).toBe(1);
  const record = store.get(store.list().items[0]!.id)!;
  expect(record).toMatchObject({
    sessionId: "native-owner",
    runId: "native-run",
    traceId: "native-run",
    workspacePath: root,
    purpose: "external_delegation",
    status: "completed",
    input: {
      messages: [{ role: "user", content: "actual delegated request" }],
      parameters: { launchCwd: root, promptViaStdin: true },
    },
    output: { text: result.finalText },
  });
  expect(record.attempts.map((attempt) => attempt.coverage)).toEqual(["external-cli-input"]);
  expect(record.usage).toBeUndefined();
  expect(record.sessionId).not.toBe(result.sessionId);
});

test("CLI spawn failure closes its existing trace, and default metadata mode stores no submitted prompt or output", async () => {
  const { root, store, run } = fixture(false);
  await run();
  await expect(run(join(root, "missing-cli"))).rejects.toThrow("未找到命令");
  const rows = store.list().items;
  expect(rows).toHaveLength(2);
  expect(rows.some((row) => row.status === "failed")).toBe(true);
  for (const row of rows) {
    const record = store.get(row.id)!;
    expect(record.endedAt).toBeGreaterThanOrEqual(record.startedAt);
    expect(record.inputState).toBe("not-recorded");
    expect(record.outputState).toBe("not-recorded");
    expect(JSON.stringify(record)).not.toContain("actual delegated request");
    expect(JSON.stringify(record)).not.toContain("Visible CLI reply");
  }
});
