/**
 * Process lifecycle of the Claude Code runtime, driven by a FAKE `claude`
 * executable so CI needs no binary or login. Never run the real CLI here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "@cjhyy/code-shell-core/extension";
import { ClaudeCodeRuntime, type ClaudeRuntimeOptions } from "./runtime.js";

const dirs: string[] = [];
const pids: number[] = [];
const runtimes: ClaudeCodeRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  // The fixtures ignore SIGTERM on purpose. Whatever production did, never leak
  // one past its test.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already reaped */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Write an executable fake `claude`. `body` may use `MARKER` (a file path in the
 * fixture directory). The pid is recorded only AFTER the body ran, so signal
 * handlers are installed before the test can send a signal.
 */
function fakeClaude(body: string): {
  command: string;
  pidFile: string;
  marker: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-claude-runtime-"));
  dirs.push(dir);
  const pidFile = join(dir, "pid");
  const marker = join(dir, "marker");
  const command = join(dir, "claude.mjs");
  writeFileSync(
    command,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const MARKER = ${JSON.stringify(marker)};
${body}
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
`,
  );
  chmodSync(command, 0o755);
  return { command, pidFile, marker };
}

const FAKE_BRIDGE = {
  url: "http://127.0.0.1:9/mcp",
  token: "fake-token",
  tokenEnvVar: "CODESHELL_FAKE_BRIDGE_TOKEN",
  close: async () => {},
};

function runtime(command: string, extra: Partial<ClaudeRuntimeOptions> = {}): ClaudeCodeRuntime {
  const created = new ClaudeCodeRuntime({
    cwd: process.cwd(),
    businessSessionId: "sess-claude-runtime",
    bridge: FAKE_BRIDGE,
    exposedToolNames: [],
    command,
    ...extra,
  });
  runtimes.push(created);
  return created;
}

async function waitForPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) {
    if (Date.now() > deadline) throw new Error("fake claude never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const pid = Number(readFileSync(pidFile, "utf8"));
  pids.push(pid);
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Ignores SIGTERM and never produces a result: the shape of a wedged CLI.
const IGNORES_SIGTERM = `
process.on("SIGTERM", () => writeFileSync(MARKER, "ignored"));
setInterval(() => {}, 1_000);
`;

describe("ClaudeCodeRuntime lifecycle (E03)", () => {
  test("init and assistant identity resolve aliases before the terminal event is published", async () => {
    const fake = fakeClaude(`
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "system", subtype: "init", session_id: "model-session", model: "init-model" });
send({ type: "assistant", message: { model: "actual-assistant-model", content: [] } });
send({ type: "result", subtype: "success", is_error: false });
`);
    const claude = runtime(fake.command, { model: "requested-alias" });
    const observed: Array<string | undefined> = [];
    expect(claude.resolvedModel).toBe("requested-alias");
    const turn = await claude.send({ text: "hello" }, (event) => {
      if (event.type === "session_started" || event.type === "turn_complete") {
        observed.push(claude.resolvedModel);
      }
    });
    await turn.done;
    expect(claude.resolvedModel).toBe("actual-assistant-model");
    expect(observed).toContain("init-model");
    expect(observed.at(-1)).toBe("actual-assistant-model");
  });

  test("streamed root identity is retained across turns while sub-agent and synthetic models are ignored", async () => {
    const fake = fakeClaude(`
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "system", subtype: "init", session_id: "model-session" });
if (!process.argv.includes("--resume")) {
  send({ type: "stream_event", event: { type: "message_start", message: { model: "root-model" } } });
}
send({ type: "assistant", parent_tool_use_id: "child-call", message: { model: "child-model", content: [] } });
send({ type: "assistant", message: { model: "<synthetic>", content: [] } });
send({ type: "result", subtype: "success", is_error: false });
`);
    const claude = runtime(fake.command);
    expect(claude.resolvedModel).toBeUndefined();
    await (
      await claude.send({ text: "one" })
    ).done;
    expect(claude.resolvedModel).toBe("root-model");
    await (
      await claude.send({ text: "two" })
    ).done;
    expect(claude.resolvedModel).toBe("root-model");
    const replacement = runtime(fake.command, { model: "replacement-model" });
    expect(replacement.resolvedModel).toBe("replacement-model");
  });

  test("missing or malformed identity preserves the configured fallback", async () => {
    const fake = fakeClaude(`
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "system", subtype: "init", session_id: "model-session", model: " " });
send({ type: "assistant", message: { model: 123, content: [] } });
send({ type: "result", subtype: "success", is_error: false });
`);
    const claude = runtime(fake.command, { model: "configured-model" });
    await (
      await claude.send({ text: "hello" })
    ).done;
    expect(claude.resolvedModel).toBe("configured-model");
  });

  test.each(["close", "interrupt"] as const)(
    "%s() escalates to SIGKILL when the CLI ignores SIGTERM, and settles the turn",
    async (method) => {
      const fake = fakeClaude(IGNORES_SIGTERM);
      const events: StreamEvent[] = [];
      const claude = runtime(fake.command, { interruptGraceMs: 200 });
      const turn = await claude.send({ text: "hello" }, (event) => events.push(event));
      const pid = await waitForPid(fake.pidFile);
      expect(alive(pid)).toBe(true);

      const started = Date.now();
      await claude[method]();
      // close()/interrupt() return only once the process is really gone.
      expect(alive(pid)).toBe(false);
      expect(readFileSync(fake.marker, "utf8")).toBe("ignored");
      expect(Date.now() - started).toBeLessThan(5_000);

      // The pending turn reached a terminal outcome instead of hanging.
      await turn.done;
      const terminal = events.filter((event) => event.type === "turn_complete");
      expect(terminal).toEqual([{ type: "turn_complete", reason: "aborted_streaming" }]);
      // A stop the user asked for is not reported as a model failure.
      expect(events.some((event) => event.type === "error")).toBe(false);
    },
  );

  test("a CLI that honours SIGTERM is not SIGKILLed", async () => {
    const fake = fakeClaude(`
process.on("SIGTERM", () => { writeFileSync(MARKER, "exit"); process.exit(0); });
setInterval(() => {}, 1_000);
`);
    const events: StreamEvent[] = [];
    const claude = runtime(fake.command, { interruptGraceMs: 10_000 });
    const turn = await claude.send({ text: "hello" }, (event) => events.push(event));
    const pid = await waitForPid(fake.pidFile);
    const started = Date.now();
    await claude.interrupt();
    expect(alive(pid)).toBe(false);
    expect(readFileSync(fake.marker, "utf8")).toBe("exit");
    // Well inside the grace period: no needless wait for the SIGKILL timer.
    expect(Date.now() - started).toBeLessThan(5_000);
    await turn.done;
    expect(events.filter((event) => event.type === "turn_complete")).toEqual([
      { type: "turn_complete", reason: "aborted_streaming" },
    ]);
  });

  test("a crash that was not requested still reports a model error", async () => {
    const fake = fakeClaude(`setTimeout(() => process.exit(3), 10);`);
    const events: StreamEvent[] = [];
    const claude = runtime(fake.command);
    const turn = await claude.send({ text: "hello" }, (event) => events.push(event));
    await turn.done;
    expect(events.at(-1)).toEqual({ type: "turn_complete", reason: "model_error" });
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  test("the runtime can run another turn after an interrupt", async () => {
    const fake = fakeClaude(`
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.argv.includes("--resume")) {
  send({ type: "result", subtype: "success", is_error: false });
  process.exit(0);
}
send({ type: "system", subtype: "init", session_id: "claude-session-1" });
setInterval(() => {}, 1_000);
`);
    const claude = runtime(fake.command, { interruptGraceMs: 200 });
    const first = await claude.send({ text: "one" });
    await waitForPid(fake.pidFile);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await claude.interrupt();
    await first.done;
    const events: StreamEvent[] = [];
    const second = await claude.send({ text: "two" }, (event) => events.push(event));
    await second.done;
    expect(events.at(-1)).toEqual({ type: "turn_complete", reason: "completed" });
  });
});
