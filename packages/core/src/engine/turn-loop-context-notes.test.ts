import { describe, expect, test } from "bun:test";
import { ContextManager } from "../context/manager.js";
import { SessionContextNotes } from "../context/notes.js";
import { estimateTokens } from "../context/compaction.js";
import { Transcript, hasCompleteContextToolPairs } from "../session/transcript.js";
import type { Message } from "../types.js";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";

function history(): Transcript {
  const transcript = Transcript.inMemory("notes-loop");
  for (let index = 0; index < 20; index++) {
    transcript.appendMessage(
      index % 2 === 0 ? "user" : "assistant",
      `old ${index}: ${"detail ".repeat(500)}`,
    );
  }
  transcript.appendMessage("user", "Latest correction: wait for my answer before publishing.", {
    clientMessageId: "latest",
  });
  return transcript;
}

function harness(
  transcript: Transcript,
  manager: ContextManager,
  extras?: {
    retained?: Message[];
    volatile?: Message[];
    signal?: AbortSignal;
  },
) {
  const notes = new SessionContextNotes(transcript);
  const loop = new TurnLoop(
    {
      transcript,
      contextManager: manager,
      contextNotes: notes,
      tools: [{ name: "SaveContextNote", description: "", inputSchema: {} }],
    } as TurnLoopDeps,
    {
      maxTurns: 10,
      maxToolCallsPerTurn: 10,
      retainedContextMessages: extras?.retained,
      volatileContextMessages: extras?.volatile,
      signal: extras?.signal,
    },
  );
  return {
    notes,
    loop: loop as unknown as {
      manageContextMessages(messages: Message[]): Promise<Message[]>;
      applyNotesRollover(messages: Message[]): Message[];
      trackFreshImageMessage(message: Message): void;
      appendContextReminder(messages: Message[], message: Message, retainForRun?: boolean): void;
    },
  };
}

describe("TurnLoop notes context policy", () => {
  test("does not count retained instructions as removable history when checking shrinkage", () => {
    const transcript = Transcript.inMemory("short-history");
    transcript.appendMessage("user", "Earlier request.");
    transcript.appendMessage("assistant", "A short result.");
    transcript.appendMessage("user", "Continue.");
    const retained: Message = { role: "user", content: "standing policy ".repeat(5_000) };
    const { notes, loop } = harness(transcript, new ContextManager(), { retained: [retained] });
    notes.markModelBoundary();
    notes.save("An unnecessarily long note for a small conversation. ".repeat(30));
    notes.requestRollover();
    const current = [retained, ...transcript.toMessages()];
    expect(loop.applyNotesRollover(current)).toBe(current);
    expect(transcript.getEvents("context_checkpoint")).toHaveLength(0);
  });

  test("preserves newly injected hooks and unread loop reminders across rollover", async () => {
    const transcript = history();
    const manager = new ContextManager({ maxTokens: 1_000_000 });
    const { notes, loop } = harness(transcript, manager);
    notes.markModelBoundary();
    notes.save("Prepare the release draft; await the user before publishing.");
    const current = transcript.toMessages();
    const hook: Message = {
      role: "user",
      content: "LATEST_HOOK: the release target has changed to staging",
    };
    const reminder: Message = {
      role: "user",
      content: "LAST_TURN: finish with the remaining blockers",
    };
    loop.appendContextReminder(current, hook, true);
    loop.appendContextReminder(current, reminder);
    notes.requestRollover();
    const next = loop.applyNotesRollover(current);
    expect(next).toContain(hook);
    expect(next).toContain(reminder);
    expect(JSON.stringify(transcript.getEvents("context_checkpoint"))).not.toContain("LATEST_HOOK");
    expect(JSON.stringify(next)).not.toContain("old 0:");
  });

  test("warns once with room to save a note instead of invoking the micro no-op summarizer", async () => {
    const transcript = history();
    const original = transcript.toMessages();
    const manager = new ContextManager({ maxTokens: estimateTokens(original) / 0.77 });
    let summaries = 0;
    manager.setSummarizeFn(async () => {
      summaries++;
      return "fallback ".repeat(30);
    });
    const { loop } = harness(transcript, manager);
    const warned = await loop.manageContextMessages(original);
    expect(summaries).toBe(0);
    expect(JSON.stringify(warned)).toContain("Context budget is running low");
    const again = await loop.manageContextMessages(warned);
    expect(JSON.stringify(again).match(/Context budget is running low/g)).toHaveLength(1);
    expect(summaries).toBe(0);
  });

  test("automatically uses a saved note under pressure, retaining instructions and live context", async () => {
    const transcript = history();
    const retained: Message = {
      role: "user",
      content: "STANDING_INSTRUCTION: no publication without user confirmation",
    };
    const volatile: Message = { role: "user", content: "HOST_LIVE_STATE: task paused" };
    const original = [retained, ...transcript.toMessages(), volatile];
    const manager = new ContextManager({ maxTokens: estimateTokens(original) / 0.88 });
    let summaries = 0;
    manager.setSummarizeFn(async () => {
      summaries++;
      return "fallback ".repeat(30);
    });
    const events: string[] = [];
    manager.setOnCompact((event) => events.push(event.strategy));
    const { notes, loop } = harness(transcript, manager, {
      retained: [retained],
      volatile: [volatile],
    });
    notes.markModelBoundary();
    notes.save(
      "Prepare the release draft. The user has not answered the publication question; wait. References: latest.",
    );
    const next = await loop.manageContextMessages(original);
    expect(summaries).toBe(0);
    expect(events).toEqual(["notes"]);
    expect(next[0]).toBe(retained);
    expect(next.at(-1)).toBe(volatile);
    expect(JSON.stringify(next)).toContain("Latest correction: wait for my answer");
    expect(JSON.stringify(next)).not.toContain("old 0:");
    const checkpoint = transcript.getEvents("context_checkpoint")[0]!;
    expect(JSON.stringify(checkpoint)).not.toContain("HOST_LIVE_STATE");
    expect(JSON.stringify(checkpoint)).not.toContain("STANDING_INSTRUCTION");
    expect(manager.getActualUsageAnchor()).toBeUndefined();
  });

  test("falls back to the existing summarizer at the compact gate without a note", async () => {
    const transcript = history();
    const original = transcript.toMessages();
    const manager = new ContextManager({ maxTokens: estimateTokens(original) / 0.88 });
    let summaries = 0;
    manager.setSummarizeFn(async () => {
      summaries++;
      return "Current task is to prepare a release draft. Await the user's publication decision. ".repeat(
        2,
      );
    });
    const { loop } = harness(transcript, manager);
    const next = await loop.manageContextMessages(original);
    expect(summaries).toBe(1);
    expect(transcript.getEvents("context_checkpoint")).toHaveLength(0);
    expect(estimateTokens(next)).toBeLessThan(estimateTokens(original));
  });

  test("does not switch an incomplete tool batch or an aborted run", () => {
    const transcript = history();
    const controller = new AbortController();
    const { notes, loop } = harness(transcript, new ContextManager(), {
      signal: controller.signal,
    });
    notes.markModelBoundary();
    notes.save("Release draft is in progress; do not publish until the user answers.");
    transcript.appendMessage("assistant", [
      { type: "tool_use", id: "pending", name: "Read", input: {} },
    ]);
    notes.requestRollover();
    const incomplete = transcript.toMessages();
    expect(loop.applyNotesRollover(incomplete)).toBe(incomplete);
    expect(transcript.getEvents("context_checkpoint")).toHaveLength(0);
    transcript.appendToolResult("pending", "Read", "read complete");
    const complete = transcript.toMessages();
    expect(hasCompleteContextToolPairs(complete)).toBe(true);
    notes.requestRollover();
    controller.abort();
    expect(loop.applyNotesRollover(complete)).toBe(complete);
    expect(transcript.getEvents("context_checkpoint")).toHaveLength(0);
  });
});
