import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMConfig, LLMResponse } from "../types.js";

const ANCHORED_OPEN = "<anchored-summary";

// Fake provider that returns a long, fixed "summary" so summarizeRange's
// length>50 rejection gate does not swallow it — this lets archiveTurnRange
// exercise a REAL (fake) summarizer without a network call.
const fakeProvider = "fake-archive-persist";
const SUMMARY_TEXT =
  "The user and assistant discussed the old topic at length before moving on to the new topic.";
const fakeRequests: CreateMessageOptions[] = [];

class FakeSummarizerClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    fakeRequests.push(options);
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    return {
      text: SUMMARY_TEXT,
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider(fakeProvider, FakeSummarizerClient);

describe("Engine archive persistence", () => {
  let dir: string;
  let engine: Engine;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-eng-arch-"));
    engine = new Engine({
      // Unregistered provider name: createLLMClient throws synchronously
      // (LLMError "Unknown LLM provider"), so prepareContextManagerForSession's
      // catch fires and no summarizeFn ever gets wired — fast, no network I/O.
      llm: {
        provider: "no-such-provider",
        model: "does-not-exist",
        apiKey: "",
      } satisfies LLMConfig,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      headless: true,
    });
    (engine as any).hooks.clear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedSession(): string {
    const bundle = (engine as any).sessionManager.create(dir, "does-not-exist", "openai");
    bundle.transcript.appendMessage("user", "旧话题", { clientMessageId: "m1" });
    bundle.transcript.appendMessage("assistant", "旧回复");
    bundle.transcript.appendMessage("user", "新话题", { clientMessageId: "m2" });
    return bundle.state.sessionId;
  }

  it("appendArchiveMarker persists a replayable marker and drops the cache", async () => {
    const sessionId = seedSession();
    const appended = await engine.appendArchiveMarker(sessionId, {
      summary: "旧话题的摘要",
      toClientMessageId: "m2",
      segmentId: "migration-v1",
    });
    expect(appended).toBe(true);

    const session = (engine as any).sessionManager.resume(sessionId);
    const events = session.transcript.getEvents("range_archive");
    expect(events).toHaveLength(1);
    // The persisted summary must carry the anchored-summary envelope, not
    // just the bare inner text — that's what lets a later rolling-merge
    // (summarizeRange / forceSummarize) find and merge-update it after a
    // restart. A regression that stores only the inner text would silently
    // break that contract without any of the other assertions here noticing.
    expect(String(events[0]!.data.summary)).toContain(ANCHORED_OPEN);
    // The envelope should also carry a recovery pointer to the full transcript
    // file, so the model can Read back exact detail on demand even if the
    // journal-derived summary is missing or truncated.
    expect(String(events[0]!.data.summary)).toContain(".jsonl");
    const texts = session.transcript
      .toMessages()
      .map((m: { content: unknown }) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((x: string) => x.includes("旧话题的摘要"))).toBe(true);
    expect(texts.some((x: string) => x === "旧话题")).toBe(false);
    expect(texts.some((x: string) => x === "新话题")).toBe(true);
  });

  it("appendArchiveMarker rejects a dead anchor without burning the segmentId", async () => {
    const sessionId = seedSession();
    const rejected = await engine.appendArchiveMarker(sessionId, {
      summary: "s",
      toClientMessageId: "does-not-exist",
      segmentId: "migration-v1",
    });
    expect(rejected).toBe(false);
    const session = (engine as any).sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(0);

    // Retrying with the correct anchor under the SAME segmentId must still
    // succeed — proving the failed dead-anchor attempt did not burn it.
    const retried = await engine.appendArchiveMarker(sessionId, {
      summary: "s",
      toClientMessageId: "m2",
      segmentId: "migration-v1",
    });
    expect(retried).toBe(true);
    const sessionAfter = (engine as any).sessionManager.resume(sessionId);
    expect(sessionAfter.transcript.getEvents("range_archive")).toHaveLength(1);
  });

  it("appendArchiveMarker rejects a dead fromClientMessageId anchor", async () => {
    const sessionId = seedSession();
    const rejected = await engine.appendArchiveMarker(sessionId, {
      summary: "s",
      toClientMessageId: "m2",
      fromClientMessageId: "does-not-exist",
      segmentId: "migration-v2",
    });
    expect(rejected).toBe(false);
    const session = (engine as any).sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(0);
  });

  it("appendArchiveMarker is idempotent on segmentId", async () => {
    const sessionId = seedSession();
    await engine.appendArchiveMarker(sessionId, {
      summary: "s",
      toClientMessageId: "m2",
      segmentId: "migration-v1",
    });
    const second = await engine.appendArchiveMarker(sessionId, {
      summary: "s",
      toClientMessageId: "m2",
      segmentId: "migration-v1",
    });
    expect(second).toBe(false);
  });

  it("archiveTurnRange without a summarizer persists no marker", async () => {
    const sessionId = seedSession();
    // llm config points at a non-existent fake provider → createLLMClient
    // throws → summarizeFn never gets wired → summarizeRange returns the
    // input array unchanged → no marker should be written.
    const result = await engine.archiveTurnRange(
      sessionId,
      { start: 0, end: 2 },
      { toClientMessageId: "m2", fromClientMessageId: "m1", segmentId: "seg-1" },
    );
    expect(result.after).toBe(result.before);
    const session = (engine as any).sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(0);
  });

  it("archiveTurnRange with a working summarizer persists a marker matching the anchored summary", async () => {
    const summarizerDir = mkdtempSync(join(tmpdir(), "cs-eng-arch-sum-"));
    const summarizerEngine = new Engine({
      llm: {
        provider: fakeProvider,
        model: "fake-model",
        apiKey: "test",
      } satisfies LLMConfig,
      cwd: summarizerDir,
      sessionStorageDir: join(summarizerDir, "sessions"),
      headless: true,
    });
    (summarizerEngine as any).hooks.clear();
    try {
      const bundle = (summarizerEngine as any).sessionManager.create(
        summarizerDir,
        "fake-model",
        fakeProvider,
      );
      bundle.transcript.appendMessage("user", "旧话题", { clientMessageId: "m1" });
      bundle.transcript.appendMessage("assistant", "旧回复");
      bundle.transcript.appendMessage("user", "新话题", { clientMessageId: "m2" });
      const sessionId = bundle.state.sessionId;

      const result = await summarizerEngine.archiveTurnRange(
        sessionId,
        { start: 0, end: 2 },
        { toClientMessageId: "m2", fromClientMessageId: "m1", segmentId: "seg-real" },
      );
      // The fake summary text is longer than the two short seed messages it
      // replaces, so token count isn't a useful signal here; what matters is
      // that summarization actually ran and replaced the span (asserted via
      // the persisted marker + replay below).
      expect(result.after).not.toBe(result.before);

      const session = (summarizerEngine as any).sessionManager.resume(sessionId);
      const events = session.transcript.getEvents("range_archive");
      expect(events).toHaveLength(1);
      expect(typeof events[0].data.summary).toBe("string");
      expect(events[0].data.summary as string).toContain(SUMMARY_TEXT);
      // Same envelope contract as appendArchiveMarker: archiveTurnRange's
      // persisted marker must carry the anchored-summary wrapper (it comes
      // straight from summarizeRange's own buildAnchoredSummaryMessage call),
      // not just the bare summary text.
      expect(String(events[0]!.data.summary)).toContain(ANCHORED_OPEN);

      const texts = session.transcript
        .toMessages()
        .map((m: { content: unknown }) => (typeof m.content === "string" ? m.content : ""));
      expect(texts.some((x: string) => x.includes(SUMMARY_TEXT))).toBe(true);
      expect(texts.some((x: string) => x === "旧话题")).toBe(false);
      expect(texts.some((x: string) => x === "新话题")).toBe(true);
    } finally {
      rmSync(summarizerDir, { recursive: true, force: true });
    }
  });

  it("archives history after appending the boundary message but before its first model call", async () => {
    const summarizerDir = mkdtempSync(join(tmpdir(), "cs-eng-pre-run-archive-"));
    const summarizerEngine = new Engine({
      llm: {
        provider: fakeProvider,
        model: "fake-model",
        apiKey: "test",
      } satisfies LLMConfig,
      cwd: summarizerDir,
      sessionStorageDir: join(summarizerDir, "sessions"),
      headless: true,
    });
    (summarizerEngine as any).hooks.clear();
    fakeRequests.length = 0;
    try {
      const bundle = (summarizerEngine as any).sessionManager.create(
        summarizerDir,
        "fake-model",
        fakeProvider,
      );
      bundle.transcript.appendMessage("user", "OLD TOPIC MUST DISAPPEAR", {
        clientMessageId: "old-boundary",
      });
      bundle.transcript.appendMessage("assistant", "OLD REPLY MUST DISAPPEAR");

      await summarizerEngine.run("BRAND NEW TOPIC", {
        sessionId: bundle.state.sessionId,
        clientMessageId: "new-boundary",
        archiveBeforeCurrentTurn: {
          fromClientMessageId: "old-boundary",
          segmentId: "seg-pre-run",
        },
      });

      const modelRequest = fakeRequests.find((request) =>
        request.messages.some((message) => String(message.content).includes("BRAND NEW TOPIC")),
      );
      expect(modelRequest).toBeDefined();
      const firstTurnHistory = modelRequest!.messages.map((message) => String(message.content));
      expect(firstTurnHistory.some((text) => text.includes(SUMMARY_TEXT))).toBe(true);
      expect(firstTurnHistory.some((text) => text.includes("OLD TOPIC MUST DISAPPEAR"))).toBe(
        false,
      );
      expect(firstTurnHistory.some((text) => text.includes("OLD REPLY MUST DISAPPEAR"))).toBe(
        false,
      );
      const persisted = (summarizerEngine as any).sessionManager.resume(bundle.state.sessionId);
      expect(
        persisted.transcript
          .getEvents("range_archive")
          .some(
            (event: { data: Record<string, unknown> }) => event.data.segmentId === "seg-pre-run",
          ),
      ).toBe(true);
    } finally {
      rmSync(summarizerDir, { recursive: true, force: true });
      fakeRequests.length = 0;
    }
  });

  it("archiveTurnRange with a dead anchor still summarizes but persists no marker", async () => {
    const summarizerDir = mkdtempSync(join(tmpdir(), "cs-eng-arch-sum-dead-"));
    const summarizerEngine = new Engine({
      llm: {
        provider: fakeProvider,
        model: "fake-model",
        apiKey: "test",
      } satisfies LLMConfig,
      cwd: summarizerDir,
      sessionStorageDir: join(summarizerDir, "sessions"),
      headless: true,
    });
    (summarizerEngine as any).hooks.clear();
    try {
      const bundle = (summarizerEngine as any).sessionManager.create(
        summarizerDir,
        "fake-model",
        fakeProvider,
      );
      bundle.transcript.appendMessage("user", "旧话题", { clientMessageId: "m1" });
      bundle.transcript.appendMessage("assistant", "旧回复");
      bundle.transcript.appendMessage("user", "新话题", { clientMessageId: "m2" });
      const sessionId = bundle.state.sessionId;

      // toClientMessageId doesn't resolve to any message event in this
      // transcript: the in-memory summarization/cache path (before/after,
      // compactedMessagesBySession) still runs, but the persistence branch
      // must reject the dead anchor and write no range_archive event.
      await summarizerEngine.archiveTurnRange(
        sessionId,
        { start: 0, end: 2 },
        { toClientMessageId: "does-not-exist", segmentId: "seg-dead" },
      );

      const session = (summarizerEngine as any).sessionManager.resume(sessionId);
      expect(session.transcript.getEvents("range_archive")).toHaveLength(0);
    } finally {
      rmSync(summarizerDir, { recursive: true, force: true });
    }
  });
});
