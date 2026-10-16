import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import type { EngineRunOptions } from "./run-types.js";

// Install confinement before evaluating Core. All provider calls below are
// scripted locally; no fixture server listens at this exact allowed origin.
installLocalNetworkGuard("http://127.0.0.1:9");
const [
  { Engine },
  { LLMClientBase },
  { registerProvider },
  { readOutputJournal },
  { asyncAgentRegistry },
  { buildNotificationMessage, notificationQueue },
  { initialToolsFixtureModule },
] = await Promise.all([
  import("./engine.js"),
  import("../llm/client-base.js"),
  import("../llm/client-factory.js"),
  import("../session/output-journal.js"),
  import("../tool-system/builtin/agent-registry.js"),
  import("../tool-system/builtin/agent-notifications.js"),
  import("./initial-tools-preset.fixture.js"),
]);

const CHILD_TASK = "OFFLINE_LATE_CHILD: inspect the fixture after the parent has yielded.";
const SIBLING_TASK = "OFFLINE_FOREGROUND_SIBLING: finish immediately.";
const LATE_TEXT = "Late child detail after the parent completion boundary.";
const FINAL_RESULT = "Verified result: the offline document contains one new row.";
const SIBLING_RESULT = "Foreground sibling check passed.";
const FOREGROUND_RESULT = "The next foreground request completed.";
const PROFILE = "background-output-fixture";
const DEADLINE_MS = 5_000;
let providerSequence = 0;
let previousThreshold: string | undefined;

beforeEach(() => {
  previousThreshold = process.env.CODE_SHELL_AGENT_BG_MS;
  asyncAgentRegistry.reset();
  notificationQueue.reset();
});

afterEach(() => {
  if (previousThreshold === undefined) delete process.env.CODE_SHELL_AGENT_BG_MS;
  else process.env.CODE_SHELL_AGENT_BG_MS = previousThreshold;
  asyncAgentRegistry.reset();
  notificationQueue.reset();
});

function deferred(label: string) {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    resolve,
    async wait(signal?: AbortSignal): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          promise,
          new Promise<never>((_done, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out waiting for ${label}`)),
              DEADLINE_MS,
            );
          }),
          new Promise<never>((_done, reject) => {
            onAbort = () => reject(new DOMException(`Aborted ${label}`, "AbortError"));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

function harness(options: { explicit: boolean; foregroundSibling?: boolean }) {
  process.env.CODE_SHELL_AGENT_BG_MS = options.explicit ? "0" : "20";
  const directory = mkdtempSync(join(tmpdir(), "engine-background-output-"));
  const sessions = join(directory, "sessions");
  const fixturePath = join(directory, "document.txt");
  writeFileSync(fixturePath, "one new row\n");
  const provider = `engine-background-output-${++providerSequence}`;
  const childEntered = deferred("the actual child provider request");
  const childRelease = deferred("late child output release");
  const parentEntered = deferred("the next foreground provider request");
  const parentRelease = deferred("the next foreground result release");
  const events: StreamEvent[] = [];
  const runs: Array<Promise<unknown>> = [];
  let parentRequests = 0;
  let holdNextParent = false;

  class Provider extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(request: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
      const respond = (text: string, toolCalls: LLMResponse["toolCalls"] = []): LLMResponse => {
        request.onChunk?.({ type: "text", text });
        this.recordUsage(usage, request);
        return { text, toolCalls, stopReason: toolCalls.length ? "tool_use" : "stop", usage };
      };
      // Session titles and other auxiliary work must remain local too, without
      // consuming one of the actual parent/child conversation steps.
      if (!request.stream || request.requestVisible === false) return respond("Offline fixture");

      if (request.tools?.some((tool) => tool.name === "Agent")) {
        parentRequests += 1;
        if (parentRequests === 1) {
          const toolCalls: LLMResponse["toolCalls"] = [
            {
              id: "launch-late-child",
              toolName: "Agent",
              args: {
                prompt: CHILD_TASK,
                description: "Late document check",
                max_turns: 3,
                ...(options.explicit ? { run_in_background: true } : {}),
              },
            },
          ];
          if (options.foregroundSibling) {
            toolCalls.push({
              id: "launch-foreground-sibling",
              toolName: "Agent",
              args: { prompt: SIBLING_TASK, description: "Foreground sibling", max_turns: 1 },
            });
          }
          return respond("Starting the document check.", toolCalls);
        }
        if (holdNextParent) {
          holdNextParent = false;
          parentEntered.resolve();
          await parentRelease.wait(request.signal);
          return respond(FOREGROUND_RESULT);
        }
        expect(JSON.stringify(request.messages)).toContain(FINAL_RESULT);
        return respond(FINAL_RESULT);
      }

      const messages = JSON.stringify(request.messages);
      if (messages.includes(SIBLING_TASK)) return respond(SIBLING_RESULT);
      expect(messages).toContain(CHILD_TASK);
      if (!messages.includes('"tool_use_id":"late-child-read"')) {
        childEntered.resolve();
        await childRelease.wait(request.signal);
        return respond(LATE_TEXT, [
          { id: "late-child-read", toolName: "Read", args: { file_path: fixturePath } },
        ]);
      }
      expect(messages).toContain("one new row");
      return respond(FINAL_RESULT);
    }
  }

  registerProvider(provider, Provider);
  const engine = new Engine({
    llm: { provider, model: "offline-fixture", apiKey: "synthetic" } as never,
    modules: [initialToolsFixtureModule(["Agent", "Read"])],
    enabledBuiltinTools: ["Agent", "Read"],
    cwd: directory,
    sessionStorageDir: sessions,
    settingsScope: "isolated",
    customSystemPrompt: "Use the locally scripted fixture tools and report their actual results.",
    permissionMode: "bypassPermissions",
    mcpServers: {},
    maxTurns: 5,
    headless: false,
    behaviorProfiles: [
      {
        id: PROFILE,
        disableSessionTitle: true,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableMcp: true,
      },
    ],
  });
  engine.getHookRegistry().clear();

  const run = (task: string, runOptions: EngineRunOptions = {}) => {
    const running = engine.run(task, {
      ...runOptions,
      behaviorMode: PROFILE,
      onStream: (event) => {
        events.push(event);
        runOptions.onStream?.(event);
      },
    });
    runs.push(running);
    return running;
  };
  const state = (sessionId: string) => engine.getSessionManager().readSessionState(sessionId);
  const childId = () => {
    const started = events.find(
      (event) => event.type === "agent_start" && event.description === "Late document check",
    );
    expect(started?.agentId).toEqual(expect.any(String));
    return started!.agentId!;
  };
  const parentTerminals = () =>
    events.filter((event) => event.type === "turn_complete" && !event.agentId);

  return {
    engine,
    sessions,
    events,
    run,
    state,
    childId,
    childEntered,
    childRelease,
    parentEntered,
    parentRelease,
    parentTerminals,
    parentRequests: () => parentRequests,
    holdNextParent: () => {
      holdNextParent = true;
    },
    async close() {
      // Release both gates even if an assertion failed. The real detached child
      // must settle before its registry or session directory can be removed.
      childRelease.resolve();
      parentRelease.resolve();
      await until(() => asyncAgentRegistry.runningCount() === 0, "detached child cleanup");
      await Promise.allSettled(runs);
      await engine.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type Harness = ReturnType<typeof harness>;

function assertLateOutput(h: Harness, sessionId: string, parentBoundary: string) {
  expect(h.state(sessionId)?.outputRecoveryIncomplete).not.toBe(true);
  const page = readOutputJournal(h.sessions, sessionId, { after: parentBoundary, maxFrames: 512 });
  expect(page.status).toBe("ok");
  expect(page.complete).toBe(true);
  const late = page.frames.find(
    (frame) => frame.event?.type === "text_delta" && frame.event.text === LATE_TEXT,
  );
  expect(late).toBeDefined();
  const origin = late!.event!.outputOriginCursor;
  expect(late!.event!.agentId).toBe(h.childId());
  expect(typeof origin).toBe("string");
  const childEvents = page.frames
    .filter((frame) => frame.event?.agentId === h.childId())
    .map((frame) => frame.event!);
  expect(childEvents.map((event) => event.type)).toEqual(
    expect.arrayContaining(["tool_use_start", "tool_result", "turn_complete", "agent_end"]),
  );
  expect(childEvents.find((event) => event.type === "agent_end")?.text).toBe(FINAL_RESULT);

  const delivered = h.events.find(
    (event) =>
      event.type === "text_delta" && event.text === LATE_TEXT && event.agentId === h.childId(),
  );
  expect(delivered!.outputCursor).toBe(late!.cursor);
  expect(delivered!.outputOriginCursor).toBe(origin);
  const parentPrefix = readOutputJournal(h.sessions, sessionId, {
    through: delivered!.outputCursor,
  });
  expect(parentPrefix.status).toBe("ok");
  expect(parentPrefix.frames.at(-1)?.event).toMatchObject({ type: "text_delta", text: LATE_TEXT });
  const childPrefix = readOutputJournal(h.sessions, h.childId(), {
    through: origin,
  });
  expect(childPrefix.status).toBe("ok");
  expect(childPrefix.frames.at(-1)?.event).toMatchObject({ type: "text_delta", text: LATE_TEXT });
  expect(readOutputJournal(h.sessions, sessionId, { through: origin }).status).toBe(
    "cursor_invalid",
  );
  expect(
    readOutputJournal(h.sessions, h.childId(), { through: delivered!.outputCursor }).status,
  ).toBe("cursor_invalid");
}

async function resumeFromNotification(h: Harness, sessionId: string) {
  const notifications = notificationQueue.drainAll(sessionId);
  expect(notifications).toHaveLength(1);
  const result = await h.run(buildNotificationMessage(notifications), {
    sessionId,
    injected: true,
  });
  expect(result.reason).toBe("completed");
  expect(result.text).toBe(FINAL_RESULT);
  expect(result.sessionId).toBe(sessionId);
  expect(h.state(sessionId)?.outputRecoveryIncomplete).not.toBe(true);
  expect(h.state(sessionId)?.lastCompletionKind).toBeUndefined();
  expect(readOutputJournal(h.sessions, sessionId).status).toBe("ok");
  expect(h.parentTerminals().at(-1)).toMatchObject({ reason: "completed", text: FINAL_RESULT });
  expect(h.parentTerminals().at(-1)).not.toHaveProperty("completionKind");
}

describe("real Engine child output after background handoff", () => {
  for (const explicit of [true, false]) {
    test(`${explicit ? "explicit background" : "automatic timeout"} journals late child details and resumes from its notification`, async () => {
      const h = harness({ explicit });
      try {
        const initial = await h.run("Check the offline document and report the verified result.");
        expect(initial.reason).toBe("completed");
        expect(h.parentRequests()).toBe(1);
        expect(h.parentTerminals()).toHaveLength(1);
        const boundary = h.parentTerminals()[0];
        expect(boundary).toMatchObject({ completionKind: "background_wait" });
        expect(boundary.outputCursor).toEqual(expect.any(String));
        expect(h.state(initial.sessionId)?.lastCompletionKind).toBe("background_wait");
        expect(asyncAgentRegistry.hasRunningForSession(initial.sessionId)).toBe(true);

        await h.childEntered.wait();
        h.childRelease.resolve();
        await until(
          () => notificationQueue.getSnapshot(initial.sessionId).length === 1,
          "the completed child notification",
        );
        assertLateOutput(h, initial.sessionId, boundary.outputCursor!);
        await resumeFromNotification(h, initial.sessionId);
        expect(h.parentRequests()).toBe(2);
      } finally {
        await h.close();
      }
    }, 15_000);
  }

  test("completes a real foreground sibling before yielding and retains the detached child's later output", async () => {
    const h = harness({ explicit: true, foregroundSibling: true });
    try {
      const initial = await h.run("Run the document check and an independent foreground check.");
      const boundary = h.parentTerminals()[0];
      expect(boundary).toMatchObject({ completionKind: "background_wait" });
      const siblingEnd = h.events.findIndex(
        (event) => event.type === "agent_end" && event.text === SIBLING_RESULT,
      );
      expect(siblingEnd).toBeGreaterThanOrEqual(0);
      expect(siblingEnd).toBeLessThan(h.events.indexOf(boundary));
      expect(h.parentRequests()).toBe(1);
      await h.childEntered.wait();
      h.childRelease.resolve();
      await until(
        () => notificationQueue.getSnapshot(initial.sessionId).length === 1,
        "the child result after its foreground sibling",
      );
      assertLateOutput(h, initial.sessionId, boundary.outputCursor!);
      await resumeFromNotification(h, initial.sessionId);
    } finally {
      await h.close();
    }
  }, 15_000);

  test("late output from the previous child remains recoverable while a newer parent run owns the Session", async () => {
    const h = harness({ explicit: true });
    try {
      const initial = await h.run("Start the detached offline document check.");
      const boundary = h.parentTerminals()[0];
      expect(boundary).toMatchObject({ completionKind: "background_wait" });
      const originalRunId = h.state(initial.sessionId)?.runId;
      expect(originalRunId).toEqual(expect.any(String));
      await h.childEntered.wait();

      h.holdNextParent();
      const foreground = h.run("Complete this independent next request.", {
        sessionId: initial.sessionId,
      });
      await h.parentEntered.wait();
      const currentRunId = h.state(initial.sessionId)?.runId;
      expect(currentRunId).toEqual(expect.any(String));
      expect(currentRunId).not.toBe(originalRunId);
      h.childRelease.resolve();
      await until(
        () => notificationQueue.getSnapshot(initial.sessionId).length === 1,
        "old child completion during the newer parent run",
      );
      assertLateOutput(h, initial.sessionId, boundary.outputCursor!);
      expect(h.state(initial.sessionId)?.runId).toBe(currentRunId);
      expect(h.parentTerminals()).toHaveLength(1);

      h.parentRelease.resolve();
      const completed = await foreground;
      expect(completed.reason).toBe("completed");
      expect(completed.text).toBe(FOREGROUND_RESULT);
      await resumeFromNotification(h, initial.sessionId);
      expect(h.parentRequests()).toBe(3);
    } finally {
      await h.close();
    }
  }, 15_000);
});
