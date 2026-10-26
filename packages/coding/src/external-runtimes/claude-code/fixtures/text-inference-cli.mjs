import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const systemPromptFile = args[args.indexOf("--system-prompt-file") + 1];
let input = "";
for await (const chunk of process.stdin) input += chunk.toString("utf8");
const report = {
  args,
  input,
  cwd: process.cwd(),
  systemPrompt: await readFile(systemPromptFile, "utf8"),
  mode: (await stat(systemPromptFile)).mode & 0o777,
  pid: process.pid,
  authMarker: process.env.CODESHELL_TEST_AUTH_MARKER,
  maxTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  safeMode: process.env.CLAUDE_CODE_SAFE_MODE,
  nestedMarker: process.env.CLAUDECODE,
  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
  bareMode: process.env.CLAUDE_CODE_SIMPLE,
  bridgeToken: process.env.CODESHELL_CODEX_MCP_TOKEN,
  hostMcp: process.env.CODE_SHELL_HOST_MCP_SERVERS,
  traceFd: process.env.CODESHELL_MODEL_TRACE_FD,
};
const mode = process.env.CODESHELL_TEST_CLAUDE_MODE ?? "success";
let descendant;
if (mode === "tree") {
  descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  report.childPid = descendant.pid;
}
await writeFile(process.env.CODESHELL_TEST_CLAUDE_REPORT, JSON.stringify(report));
const emit = (item) => process.stdout.write(`${JSON.stringify(item)}\n`);
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "最近的结论 🙂",
  usage: {
    input_tokens: 7,
    output_tokens: 11,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 3,
  },
};
emit({ type: "system", subtype: "init", tools: [], model: "fixture-model" });
switch (mode) {
  case "hang":
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    break;
  case "tree":
    process.on("SIGTERM", () => {
      descendant.once("exit", () => process.exit(0));
      descendant.kill("SIGTERM");
    });
    setInterval(() => {}, 1000);
    break;
  case "tool":
    emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
    emit(result);
    break;
  case "raw-tool":
    emit({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read" } },
    });
    emit(result);
    break;
  case "available-tools":
    emit({ type: "system", subtype: "init", tools: ["Read"] });
    emit(result);
    break;
  case "truncated":
    emit({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "max_tokens" } },
    });
    emit(result);
    break;
  case "truncated-result":
    emit({ ...result, stop_reason: "max_tokens" });
    break;
  case "error":
    emit({ ...result, is_error: true, subtype: "error_during_execution" });
    break;
  case "max-turns":
    emit({ ...result, is_error: false, subtype: "error_max_turns" });
    break;
  case "empty":
    emit({ ...result, result: "" });
    break;
  case "malformed":
    process.stdout.write("{broken}\n");
    break;
  case "missing":
    break;
  case "duplicate":
    emit(result);
    emit(result);
    break;
  case "nonzero":
    emit(result);
    process.exitCode = 7;
    break;
  case "overflow":
    process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
    break;
  case "stderr-overflow":
    process.stderr.write("x".repeat(64 * 1024 + 1));
    break;
  default: {
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: result.result }], stop_reason: "end_turn" },
    });
    const bytes = Buffer.from(JSON.stringify(result));
    for (let index = 0; index < bytes.length; index += 7)
      process.stdout.write(bytes.subarray(index, index + 7));
  }
}
