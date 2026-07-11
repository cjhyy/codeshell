import { describe, it, expect } from "bun:test";
import { runShellHook, shellHookMatches } from "../packages/core/src/hooks/shell-runner.js";
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
    const result = await runShellHook(
      { event: "pre_tool_use", command: "true" },
      ctx(),
    );
    expect(result).toEqual({});
  });

  it("exit 0 with malformed JSON returns {} (does NOT throw)", async () => {
    const result = await runShellHook(
      { event: "pre_tool_use", command: `echo 'not json'` },
      ctx(),
    );
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
    const result = await runShellHook(
      { event: "pre_tool_use", command: "false" },
      ctx(),
    );
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

  it("returns a structured stdin_error when the hook closes stdin early", async () => {
    const result = await runShellHook(
      {
        event: "pre_tool_use",
        command: "exec 0<&-; sleep 1",
        timeout_ms: 2_000,
      },
      ctx({ payload: slowPayload() }),
    );

    const failure = result.data?.hookFailure as
      | { type?: string; code?: string; message?: string }
      | undefined;
    expect(failure?.type).toBe("stdin_error");
    expect(["EPIPE", "ECONNRESET"]).toContain(failure?.code);
    expect(failure?.message).toBeTruthy();
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
    expect(
      shellHookMatches({ event: "x", command: "y", matcher: "[unclosed" }, ctx()),
    ).toBe(false);
  });
});
