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

// Records argv and the whole stdin, then finishes the turn once stdin ends.
const RECORDS_INPUT = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  writeFileSync(MARKER, JSON.stringify({ args: process.argv.slice(2), input }));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\\n");
});
`;

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

describe("ClaudeCodeRuntime user message (stream-json input)", () => {
  async function recordedTurn(
    input: Parameters<ClaudeCodeRuntime["send"]>[0],
    extra: Partial<ClaudeRuntimeOptions> = {},
  ): Promise<{ args: string[]; message: any; lines: string[] }> {
    const fake = fakeClaude(RECORDS_INPUT);
    const claude = runtime(fake.command, extra);
    await (
      await claude.send(input)
    ).done;
    const recorded = JSON.parse(readFileSync(fake.marker, "utf8")) as {
      args: string[];
      input: string;
    };
    expect(recorded.input.endsWith("\n")).toBe(true);
    const lines = recorded.input.split("\n").filter(Boolean);
    return { args: recorded.args, message: JSON.parse(lines[0]!), lines };
  }

  function attachmentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-claude-attachments-"));
    dirs.push(dir);
    return dir;
  }

  test("a text-only turn is one stream-json user line with a single text block", async () => {
    const { args, message, lines } = await recordedTurn({ text: "hello there" });
    expect(args.slice(0, 5)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ]);
    expect(lines).toHaveLength(1);
    expect(message).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello there" }] },
    });
  });

  test("first-turn context replay wraps the prompt text", async () => {
    const { message } = await recordedTurn(
      { text: "now" },
      { initialContext: "earlier transcript" },
    );
    expect(message.message.content).toEqual([
      {
        type: "text",
        text: "earlier transcript\n\n<current_user_request>\nnow\n</current_user_request>",
      },
    ]);
  });

  test("an image attachment becomes a native base64 image block and keeps its path reference", async () => {
    const dir = attachmentDir();
    // Named .jpg on purpose: the media type comes from the bytes.
    const image = join(dir, "shot.jpg");
    writeFileSync(image, PNG_BYTES);
    const { message } = await recordedTurn({
      text: "what is this?",
      attachments: [{ path: image, kind: "image", mime: "image/jpeg" }],
    });
    expect(message.message.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") },
      },
      {
        type: "text",
        text: [
          "what is this?",
          "",
          "<codeshell_attachments>",
          "The user explicitly attached these local paths. Inspect them when relevant:",
          `- image: ${image}`,
          "</codeshell_attachments>",
        ].join("\n"),
      },
    ]);
  });

  test("non-image attachments stay path references next to inline images", async () => {
    const dir = attachmentDir();
    const image = join(dir, "a.png");
    writeFileSync(image, PNG_BYTES);
    const { message } = await recordedTurn({
      text: "compare",
      attachments: [
        { path: image, kind: "image", mime: "image/png" },
        { path: "/repo/notes.md", kind: "file" },
        { path: "/repo/src", kind: "directory" },
      ],
    });
    const content = message.message.content as Array<{ type: string; text?: string }>;
    expect(content.map((block) => block.type)).toEqual(["image", "text"]);
    expect(content[1]!.text).toBe(
      [
        "compare",
        "",
        "<codeshell_attachments>",
        "The user explicitly attached these local paths. Inspect them when relevant:",
        `- image: ${image}`,
        "- file: /repo/notes.md",
        "- directory: /repo/src",
        "</codeshell_attachments>",
      ].join("\n"),
    );
  });

  test("oversized, unsupported or missing images fall back to path references", async () => {
    const dir = attachmentDir();
    const huge = join(dir, "huge.png");
    // PNG signature, but past the per-image limit.
    writeFileSync(huge, Buffer.concat([PNG_BYTES, Buffer.alloc(4 * 1024 * 1024)]));
    const svg = join(dir, "logo.svg");
    writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const missing = join(dir, "gone.png");
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const { message } = await recordedTurn(
      {
        text: "look",
        attachments: [
          { path: huge, kind: "image" },
          { path: svg, mime: "image/svg+xml" },
          { path: missing, kind: "image" },
        ],
      },
      { log: (event, data) => logs.push({ event, data }) },
    );
    const content = message.message.content as Array<{ type: string; text?: string }>;
    expect(content.map((block) => block.type)).toEqual(["text"]);
    expect(content[0]!.text).toContain(`- image: ${huge}`);
    expect(content[0]!.text).toContain(`- file: ${svg}`);
    expect(content[0]!.text).toContain(`- image: ${missing}`);
    expect(logs.find((entry) => entry.event === "claude.image_attachments")?.data).toEqual({
      inline: 0,
      fallbacks: ["too_large", "unsupported_type", "unreadable"],
    });
  });
});
