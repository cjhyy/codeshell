import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import {
  isHookStdinReaderGone,
  runShellHook,
  shellHookMatches,
  stdinFailure,
  writeHookStdin,
} from "../packages/core/src/hooks/shell-runner.js";
import type { HookContext } from "../packages/core/src/hooks/events.js";

function ctx(extra: Partial<HookContext["data"]> = {}): HookContext {
  return {
    eventName: "pre_tool_use",
    data: { toolName: "Edit", args: { file_path: "/x" }, ...extra },
  };
}

function slowPayload(): { toJSON: () => string } {
  return {
    toJSON: () => {
      // Serialization happens after spawn. Give the hook enough wall time to
      // close fd 0 before the parent starts its still-under-cap write.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return "x".repeat(200 * 1024);
    },
  };
}

describe("runShellHook — exit codes", () => {
  it("exit 0 with valid JSON stdout becomes the HookResult", async () => {
    const result = await runShellHook(
      {
        event: "pre_tool_use",
        command: `echo '{"messages": ["hello"]}'`,
      },
      ctx(),
    );
    expect(result.messages).toEqual(["hello"]);
  });

  it("exit 0 with blank stdout returns {}", async () => {
    const result = await runShellHook({ event: "pre_tool_use", command: "true" }, ctx());
    expect(result).toEqual({});
  });

  it("exit 0 with malformed JSON returns {} (does NOT throw)", async () => {
    const result = await runShellHook({ event: "pre_tool_use", command: `echo 'not json'` }, ctx());
    expect(result).toEqual({});
  });

  it("exit 2 maps to decision:deny with stderr as reason", async () => {
    const result = await runShellHook(
      {
        event: "pre_tool_use",
        // Shell `&&` so stderr write happens before the non-zero exit.
        command: `sh -c 'echo "sandbox violation" >&2 && exit 2'`,
      },
      ctx(),
    );
    expect(result.decision).toBe("deny");
    expect(result.messages?.[0]).toContain("sandbox violation");
  });

  it("non-2 non-0 exit returns {} (handler error, swallowed)", async () => {
    const result = await runShellHook({ event: "pre_tool_use", command: "false" }, ctx());
    expect(result).toEqual({});
  });
});

describe("runShellHook — protocol", () => {
  it("writes ctx envelope on stdin so the script can read it", async () => {
    // Round-trip: hook reads stdin and echoes a derived value.
    const result = await runShellHook(
      {
        event: "pre_tool_use",
        command: `cat | node -e '
          const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
          process.stdout.write(JSON.stringify({ messages: ["received: " + c.data.toolName] }));
        '`,
      },
      ctx(),
    );
    expect(result.messages).toEqual(["received: Edit"]);
  });

  it("passes CODESHELL_HOOK_EVENT in env", async () => {
    const result = await runShellHook(
      {
        event: "pre_tool_use",
        command: `node -e 'process.stdout.write(JSON.stringify({ messages: [process.env.CODESHELL_HOOK_EVENT] }))'`,
      },
      ctx(),
    );
    expect(result.messages).toEqual(["pre_tool_use"]);
  });

  it("judges a hook that closes stdin early by its exit status (deny is not lost)", async () => {
    const result = await runShellHook(
      {
        event: "pre_tool_use",
        // fd 0 is closed while the hook is alive, so the write hits EPIPE.
        command: "exec 0<&-; sleep 0.3; echo blocked >&2; exit 2",
        timeout_ms: 2_000,
      },
      ctx({ payload: slowPayload() }),
    );
    expect(result).toEqual({ decision: "deny", messages: ["blocked"] });
  });

  it("judges a hook that exits before reading stdin by its exit status", async () => {
    const deny = await runShellHook(
      { event: "pre_tool_use", command: "echo blocked >&2; exit 2", timeout_ms: 2_000 },
      ctx({ payload: slowPayload() }),
    );
    expect(deny).toEqual({ decision: "deny", messages: ["blocked"] });
    const ok = await runShellHook(
      { event: "pre_tool_use", command: `echo '{"messages": ["hi"]}'`, timeout_ms: 2_000 },
      ctx({ payload: slowPayload() }),
    );
    expect(ok).toEqual({ messages: ["hi"] });
  });

  it("closes stdin without an envelope when the serialized context exceeds 256 KiB", async () => {
    const result = await runShellHook(
      {
        event: "pre_tool_use",
        command: `node -e '
          let input = "";
          process.stdin.on("data", (chunk) => input += chunk);
          process.stdin.on("end", () => {
            process.stdout.write(JSON.stringify({ messages: [String(Buffer.byteLength(input))] }));
          });
        '`,
      },
      ctx({ payload: "x".repeat(300 * 1024) }),
    );

    expect(result.messages).toEqual(["0"]);
  });
});

describe("runShellHook — timeout", () => {
  it("kills child after timeout_ms and returns {}", async () => {
    const start = Date.now();
    const result = await runShellHook(
      {
        event: "pre_tool_use",
        command: "sleep 5",
        timeout_ms: 200,
      },
      ctx(),
    );
    const elapsed = Date.now() - start;
    expect(result).toEqual({});
    // Sanity: must come back well under the 5s sleep — proves SIGTERM landed.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("shellHookMatches", () => {
  it("returns true when matcher is absent", () => {
    expect(shellHookMatches({ event: "x", command: "y" }, ctx())).toBe(true);
  });

  it("matches tool name against matcher regex", () => {
    expect(
      shellHookMatches(
        { event: "x", command: "y", matcher: "Edit|Write" },
        ctx({ toolName: "Edit" }),
      ),
    ).toBe(true);
    expect(
      shellHookMatches(
        { event: "x", command: "y", matcher: "Edit|Write" },
        ctx({ toolName: "Read" }),
      ),
    ).toBe(false);
  });

  it("returns false when matcher is set but ctx has no toolName", () => {
    expect(
      shellHookMatches(
        { event: "x", command: "y", matcher: ".*" },
        { eventName: "on_session_start", data: { sessionId: "s" } },
      ),
    ).toBe(false);
  });

  it("returns false on invalid regex (no crash)", () => {
    expect(shellHookMatches({ event: "x", command: "y", matcher: "[unclosed" }, ctx())).toBe(false);
  });
});

/**
 * Scripted stand-in for a child's stdin: reports each step in the order a
 * given runtime does, with no dependence on real pipe timing.
 */
class ScriptedStdin extends EventEmitter {
  destroyed = false;
  constructor(
    private readonly onWrite: (cb: (error?: Error | null) => void, self: ScriptedStdin) => boolean,
    private readonly onEnd: (cb: (error?: Error | null) => void, self: ScriptedStdin) => void,
  ) {
    super();
  }
  write(_chunk: string, cb: (error?: Error | null) => void): boolean {
    return this.onWrite(cb, this);
  }
  end(cb: (error?: Error | null) => void): void {
    this.onEnd(cb, this);
  }
}

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
}

describe("writeHookStdin — broken pipe orderings", () => {
  it("Bun 1.4 order: write ok, end callback fails, then `error` is emitted", async () => {
    const error = epipe();
    const stdin = new ScriptedStdin(
      (cb) => {
        cb();
        return true;
      },
      (cb, self) => {
        cb(error);
        self.emit("error", error);
        self.emit("close");
      },
    );
    await expect(writeHookStdin(stdin as unknown as Writable, "{}")).rejects.toBe(error);
    expect(stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => stdin.emit("error", epipe())).not.toThrow();
  });

  it("Node order: write callback fails, then end callback and `error` follow", async () => {
    const error = epipe();
    let ended = false;
    const stdin = new ScriptedStdin(
      (cb, self) => {
        queueMicrotask(() => {
          cb(error);
          self.emit("error", error);
        });
        return false;
      },
      () => {
        ended = true;
      },
    );
    await expect(writeHookStdin(stdin as unknown as Writable, "{}")).rejects.toBe(error);
    expect(ended).toBe(false);
    expect(() => stdin.emit("error", epipe())).not.toThrow();
  });

  it("an `error` emitted after a clean end is still handled", async () => {
    const stdin = new ScriptedStdin(
      (cb) => {
        cb();
        return true;
      },
      (cb) => cb(),
    );
    await writeHookStdin(stdin as unknown as Writable, "{}");
    expect(() => stdin.emit("error", epipe())).not.toThrow();
  });

  it("a close before end completes rejects instead of hanging", async () => {
    const stdin = new ScriptedStdin(
      (cb) => {
        cb();
        return true;
      },
      (_cb, self) => self.emit("close"),
    );
    const failure = await writeHookStdin(stdin as unknown as Writable, "{}").then(
      () => undefined,
      (error: unknown) => stdinFailure(error),
    );
    expect(failure?.code).toBe("ERR_STREAM_PREMATURE_CLOSE");
  });

  it("only a vanished reader is excused; other stdin errors stay stdin_error failures", () => {
    expect(isHookStdinReaderGone(stdinFailure(epipe()))).toBe(true);
    const eio = stdinFailure(Object.assign(new Error("i/o"), { code: "EIO" }));
    expect(eio).toEqual({ type: "stdin_error", code: "EIO", message: "i/o" });
    expect(isHookStdinReaderGone(eio)).toBe(false);
  });
});
