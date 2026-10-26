import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessGroup, type TokenUsage } from "@cjhyy/code-shell-core/extension";

export interface ClaudeTextInferenceOptions {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function usageFromResult(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  const read = raw.cache_read_input_tokens ?? 0;
  const write = raw.cache_creation_input_tokens ?? 0;
  if (
    ![input, output, read, write].every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    )
  )
    return undefined;
  const promptTokens = Number(input) + Number(read) + Number(write);
  const totalTokens = promptTokens + Number(output);
  if (!Number.isSafeInteger(totalTokens)) return undefined;
  return {
    promptTokens,
    completionTokens: Number(output),
    totalTokens,
    ...(raw.cache_read_input_tokens !== undefined ? { cacheReadTokens: Number(read) } : {}),
    ...(raw.cache_creation_input_tokens !== undefined
      ? { cacheCreationTokens: Number(write) }
      : {}),
  };
}

/** Fresh CLI inference, with no conversation, Host tools or user customizations. */
export async function runClaudeTextInference(
  options: ClaudeTextInferenceOptions,
  dependencies: { spawn?: typeof spawn } = {},
): Promise<{ text: string; usage?: TokenUsage; stopReason?: string }> {
  options.signal?.throwIfAborted();
  if (!options.systemPrompt?.trim() || !options.userMessage?.trim())
    throw new Error("Claude text inference requires a system prompt and user message");
  if (
    Buffer.byteLength(options.systemPrompt) + Buffer.byteLength(options.userMessage) >
    MAX_INPUT_BYTES
  )
    throw new Error("Claude text inference input exceeds its byte limit");
  const maxTokens = options.maxTokens ?? 3072;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128_000)
    throw new Error("Invalid Claude text inference output budget");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
    throw new Error("Invalid Claude text inference timeout");

  const cwd = await mkdtemp(join(tmpdir(), "codeshell-claude-text-"));
  try {
    await chmod(cwd, 0o700);
    const systemPromptFile = join(cwd, "system-prompt.txt");
    await writeFile(systemPromptFile, options.systemPrompt, { mode: 0o600 });
    await chmod(systemPromptFile, 0o600);
    options.signal?.throwIfAborted();
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--safe-mode",
      "--tools",
      "",
      "--disallowedTools",
      "*",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--max-turns",
      "1",
      "--system-prompt-file",
      systemPromptFile,
      ...(options.model ? ["--model", options.model] : []),
    ];
    // Safe mode keeps the CLI's auth/provider selection, unlike --bare. Managed
    // policy (including managed hooks) remains authoritative inside the CLI.
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      CLAUDE_CODE_SAFE_MODE: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
    };
    for (const name of [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SIMPLE",
      "CODESHELL_CODEX_MCP_TOKEN",
      "CODE_SHELL_HOST_MCP_SERVERS",
      "CODESHELL_MODEL_TRACE_FD",
    ])
      delete env[name];
    return await new Promise((resolve, reject) => {
      const launch = dependencies.spawn ?? spawn;
      const child = launch(options.command ?? "claude", args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      let outputBytes = 0;
      let stderrBytes = 0;
      let pending = "";
      let terminal: Record<string, unknown> | undefined;
      let stopReason: string | undefined;
      let failure: Error | undefined;
      let settling = false;
      let stopping: Promise<void> | undefined;
      const stop = () => {
        stopping ??= child.pid ? killProcessGroup(child.pid, { graceMs: 250 }) : Promise.resolve();
        return stopping;
      };
      const finish = (code?: number | null, signal?: NodeJS.Signals | null) => {
        if (settling) return;
        settling = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        void stop().then(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          if (failure) return reject(failure);
          if (code !== 0 || signal)
            return reject(
              new Error(`Claude text inference exited without success (${signal ?? code})`),
            );
          try {
            if (pending.trim()) accept(pending);
            if (!terminal) throw new Error("Claude text inference produced no terminal result");
            resolve({
              text: terminal.result as string,
              usage: usageFromResult(terminal.usage),
              stopReason,
            });
          } catch (error) {
            reject(error);
          }
        }, reject);
      };
      const fail = (error: Error) => {
        if (settling || failure) return;
        failure = error;
        void stop().then(() => finish(), reject);
      };
      const acceptStopReason = (value: unknown) => {
        if (typeof value !== "string") return;
        if (!["end_turn", "stop", "stop_sequence"].includes(value))
          throw new Error(`Claude text inference stopped without complete text (${value})`);
        stopReason = value;
      };
      const accept = (line: string) => {
        if (!line.trim()) return;
        let item: any;
        try {
          item = JSON.parse(line);
        } catch {
          throw new Error("Claude text inference emitted malformed JSON");
        }
        if (!item || typeof item !== "object" || Array.isArray(item))
          throw new Error("Claude text inference emitted a malformed event");
        const content = item.message?.content;
        const block = item.event?.content_block;
        if (
          ["tool_progress", "tool_use_summary"].includes(item.type) ||
          (item.type === "control_request" && item.request?.subtype === "can_use_tool") ||
          ["tool_use", "server_tool_use"].includes(block?.type) ||
          (Array.isArray(content) &&
            content.some((part: any) =>
              ["tool_use", "server_tool_use", "tool_result"].includes(part?.type),
            )) ||
          (item.type === "system" && item.subtype === "init" && item.tools?.length > 0)
        )
          throw new Error("Claude text inference attempted to use tools");
        if (item.type === "assistant") acceptStopReason(item.message?.stop_reason);
        if (item.type === "stream_event" && item.event?.type === "message_delta")
          acceptStopReason(item.event.delta?.stop_reason);
        if (item.type !== "result") return;
        if (terminal) throw new Error("Claude text inference emitted multiple terminal results");
        if (
          item.is_error !== false ||
          item.subtype !== "success" ||
          typeof item.result !== "string" ||
          !item.result.trim() ||
          (Array.isArray(item.errors) && item.errors.length > 0)
        )
          throw new Error("Claude text inference returned an incomplete or failed result");
        acceptStopReason(item.stop_reason);
        terminal = item;
      };
      const onAbort = () =>
        fail(Object.assign(new Error("Claude text inference aborted"), { name: "AbortError" }));
      const timer = setTimeout(
        () => fail(new Error(`Claude text inference timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settling || failure) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES)
          return fail(new Error("Claude text inference output exceeds its byte limit"));
        pending += chunk;
        try {
          for (let newline; (newline = pending.indexOf("\n")) >= 0; ) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            accept(line);
          }
        } catch (error) {
          fail(error as Error);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES)
          fail(new Error("Claude text inference diagnostics exceed their byte limit"));
      });
      child.stdin.on("error", (error) => fail(error));
      child.stdout.on("error", (error) => fail(error));
      child.stderr.on("error", (error) => fail(error));
      child.once("error", (error) => fail(error));
      child.once("close", finish);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      else child.stdin.end(options.userMessage);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
