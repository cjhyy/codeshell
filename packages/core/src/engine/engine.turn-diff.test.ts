import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent, ToolCall, TranscriptEvent } from "../types.js";
import { Engine } from "./engine.js";
import { TurnDiffTracker } from "../session/turn-diff.js";

const provider = "fake-turn-diff-execution";
const marker = "TURN_DIFF_EXECUTION_FIXTURE";
const scenarios = new Map<string, ToolCall[]>();
class DiffClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const call = options.systemPrompt.includes(marker)
      ? scenarios.get(this.model)?.shift()
      : undefined;
    const response: LLMResponse = {
      text: call ? "" : "done",
      toolCalls: call ? [call] : [],
      stopReason: call ? "tool_use" : "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    this.recordUsage(response.usage!, options);
    return response;
  }
}
registerProvider(provider, DiffClient);

describe("Engine authoritative logical-turn diff", () => {
  const roots: string[] = [];
  afterEach(() => {
    scenarios.clear();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "engine-turn-diff-"));
    roots.push(root);
    const model = root;
    const createEngine = () =>
      new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: root,
        sessionStorageDir: join(root, "sessions"),
        settingsScope: "isolated",
        permissionMode: "bypassPermissions",
        headless: true,
        enabledBuiltinTools: ["Write", "Edit"],
        maxTurns: 6,
        behaviorProfiles: [
          {
            id: "diff-fixture",
            systemPromptAppend: marker,
            allowedToolNames: new Set(["Write", "Edit"]),
            disableMcp: true,
            disableHooks: true,
            disableInstructions: true,
            disableMemoryContext: true,
            disableSessionTitle: true,
          },
        ],
      });
    return { root, model, createEngine };
  }
  test("publishes original-to-final states, persists continuation baseline and starts a fresh user baseline", async () => {
    const { root, model, createEngine } = setup();
    const file = join(root, "a.txt");
    writeFileSync(file, "header\nA\nfooter\n");
    const edit = (id: string, from: string, to: string, path = file): ToolCall => ({
      id,
      toolName: "Edit",
      args: { file_path: path, old_string: from, new_string: to },
    });
    scenarios.set(model, [edit("first", "A", "B", "a.txt"), edit("second", "B", "C")]);
    const events: StreamEvent[] = [];
    const first = await createEngine().run("edit the file twice", {
      sessionId: "s-diff",
      clientMessageId: "user-1",
      behaviorMode: "diff-fixture",
      onStream: (event) => {
        events.push(event);
      },
    });
    expect(first.reason).toBe("completed");
    const snapshots = events.filter((event) => event.type === "turn_diff");
    expect(snapshots).toHaveLength(2);
    const final = snapshots.at(-1)!;
    expect(final.files).toHaveLength(1);
    expect(final.files[0]).toMatchObject({ status: "modified", added: 1, removed: 1 });
    expect(final.files[0]!.diff).toContain("-A\n+C\n");
    expect(final.files[0]!.diff).not.toContain("+B\n");
    expect(final.outputCursor).toBeTruthy();
    const transcriptPath = join(root, "sessions/s-diff/transcript.jsonl");
    const transcript = readFileSync(transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TranscriptEvent);
    expect(final.turnId).toBe(
      transcript.find((event) => event.type === "message" && event.data.role === "user")!.id,
    );
    expect(transcript.filter((event) => event.type === "turn_diff")).toHaveLength(2);

    // A new Engine process-shaped instance must reuse the persisted original,
    // not start at the previous run's C, for an injected continuation.
    scenarios.set(model, [edit("third", "C", "D")]);
    const continued: StreamEvent[] = [];
    const continuation = await createEngine().run("continue", {
      sessionId: "s-diff",
      injected: true,
      clientMessageId: "auto-1",
      behaviorMode: "diff-fixture",
      onStream: (event) => {
        continued.push(event);
      },
    });
    expect(continuation.reason).toBe("completed");
    const cumulative = continued.filter((event) => event.type === "turn_diff").at(-1);
    expect(cumulative?.type).toBe("turn_diff");
    if (cumulative?.type !== "turn_diff") throw new Error("missing continuation snapshot");
    expect(cumulative.turnId).toBe(final.turnId);
    expect(cumulative.files[0]!.diff).toContain("-A\n+D\n");

    scenarios.set(model, [edit("fourth", "D", "E")]);
    const next: StreamEvent[] = [];
    await createEngine().run("new request", {
      sessionId: "s-diff",
      clientMessageId: "user-2",
      behaviorMode: "diff-fixture",
      onStream: (event) => {
        next.push(event);
      },
    });
    const fresh = next.find((event) => event.type === "turn_diff");
    if (fresh?.type !== "turn_diff") throw new Error("missing new user snapshot");
    expect(fresh.turnId).not.toBe(final.turnId);
    expect(fresh.files[0]!.diff).toContain("-D\n+E\n");
  });

  test("publishes interrupted capture omissions on resume even without another edit", async () => {
    const { root, model, createEngine } = setup();
    const file = join(root, "a.txt");
    writeFileSync(file, "A\n");
    scenarios.set(model, []);
    await createEngine().run("change the file", {
      sessionId: "s-recovery-diff",
      behaviorMode: "diff-fixture",
    });
    const sessionDir = join(root, "sessions/s-recovery-diff");
    const transcript = readFileSync(join(sessionDir, "transcript.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TranscriptEvent);
    const turnId = transcript.find(
      (event) => event.type === "message" && event.data.role === "user",
    )!.id;
    const interrupted = new TurnDiffTracker({ turnId, cwd: root, sessionDir });
    interrupted.begin("interrupted-write", [file]);
    writeFileSync(file, "B\n");
    // The worker disappears before end(); the resumed run does no file work.
    const events: StreamEvent[] = [];
    const result = await createEngine().run("resume", {
      sessionId: "s-recovery-diff",
      injected: true,
      behaviorMode: "diff-fixture",
      onStream: (event) => {
        events.push(event);
      },
    });
    expect(result.reason).toBe("completed");
    const recovered = events.find((event) => event.type === "turn_diff");
    if (recovered?.type !== "turn_diff") throw new Error("missing recovery snapshot");
    expect(recovered.turnId).toBe(turnId);
    expect(recovered.complete).toBe(false);
    expect(recovered.files).toEqual([]);
    expect(recovered.omissions.some((item) => item.path.endsWith("/a.txt"))).toBe(true);
  });

  test("ephemeral execution still publishes evidence without persisting files", async () => {
    const { root, model, createEngine } = setup();
    const file = join(root, "a.txt");
    scenarios.set(model, [
      { id: "create", toolName: "Write", args: { file_path: file, content: "new\n" } },
    ]);
    const events: StreamEvent[] = [];
    const result = await createEngine().run("create", {
      sessionId: "s-ephemeral-diff",
      ephemeral: true,
      behaviorMode: "diff-fixture",
      onStream: (event) => {
        events.push(event);
      },
    });
    expect(result.reason).toBe("completed");
    const snapshot = events.find((event) => event.type === "turn_diff");
    if (snapshot?.type !== "turn_diff") throw new Error("missing ephemeral snapshot");
    expect(snapshot.files[0]!.status).toBe("added");
    expect(existsSync(join(root, "sessions/s-ephemeral-diff"))).toBe(false);
  });
});
