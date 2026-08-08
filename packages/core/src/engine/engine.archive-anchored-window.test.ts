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

// Fake summarizer that RECORDS every prompt it receives and returns a
// distinct, >50-char summary per call. Capturing the prompt is what lets
// these tests assert WHICH window archiveTurnRange actually summarized —
// the whole point of the anchored-window fix is that the window must come
// from the anchors over a live replay, never from the caller's stale
// message-index range.
const fakeProvider = "fake-anchored-window";
const prompts: string[] = [];
function summaryFor(n: number): string {
  return `Fake archived summary number ${n} with enough filler text to pass the fifty character rejection gate.`;
}

class RecordingSummarizerClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const first = options.messages[0];
    prompts.push(typeof first?.content === "string" ? first.content : "");
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    return {
      text: summaryFor(prompts.length),
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider(fakeProvider, RecordingSummarizerClient);

function makeEngine(baseDir: string): Engine {
  const engine = new Engine({
    llm: {
      provider: fakeProvider,
      model: "fake-model",
      apiKey: "test",
    } satisfies LLMConfig,
    cwd: baseDir,
    sessionStorageDir: join(baseDir, "sessions"),
    headless: true,
  });
  (engine as any).hooks.clear();
  return engine;
}

describe("archiveTurnRange resolves the window from anchors over a live replay", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-anch-win-"));
    prompts.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("post-restart closure persists correctly despite a stale absolute index range", async () => {
    // Bug 1 reproduction: after a restart, the live message list is trimmed
    // by marker replay, but the pet closure still passes ABSOLUTE indices
    // computed over the raw (never-trimmed) transcript. Pre-fix those clamp
    // to an empty window → summarizeRange identity-returns → NO second
    // marker is ever persisted and the feature silently dies.
    const engineA = makeEngine(dir);
    const bundle = (engineA as any).sessionManager.create(dir, "fake-model", fakeProvider);
    const sessionId = bundle.state.sessionId;
    for (let i = 0; i < 10; i += 1) {
      bundle.transcript.appendMessage("user", `旧消息${i}`, { clientMessageId: `old-${i}` });
      bundle.transcript.appendMessage("assistant", `旧回复${i}`);
    }
    bundle.transcript.appendMessage("user", "切片一边界", { clientMessageId: "b1" });
    const appended = await engineA.appendArchiveMarker(sessionId, {
      summary: "十轮旧对话的迁移摘要",
      toClientMessageId: "b1",
      segmentId: "migration-v1",
    });
    expect(appended).toBe(true);

    // Restart: fresh Engine, empty in-process caches; replay is trimmed.
    const engineB = makeEngine(dir);
    const resumed = (engineB as any).sessionManager.resume(sessionId);
    resumed.transcript.appendMessage("assistant", "边界回复");
    resumed.transcript.appendMessage("user", "新话题第一句", { clientMessageId: "n1" });
    resumed.transcript.appendMessage("assistant", "新回复一");
    resumed.transcript.appendMessage("user", "切片二边界", { clientMessageId: "n2" });

    // Deliberately stale/absurd raw range — absolute indices over the raw
    // transcript, far beyond the ~6-message live list.
    const result = await engineB.archiveTurnRange(
      sessionId,
      { start: 340, end: 365 },
      { fromClientMessageId: "b1", toClientMessageId: "n2", segmentId: "seg-2" },
    );
    expect(result.after).not.toBe(result.before);

    // The summarized window must be the anchored span [b1, n2) of the LIVE
    // list, not whatever the stale range clamps onto.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("切片一边界");
    expect(prompts[0]).toContain("新话题第一句");
    expect(prompts[0]).not.toContain("切片二边界");

    // A SECOND marker persisted…
    const session = (engineB as any).sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(2);

    // …and a third fresh Engine replays [migration summary, seg-2 summary, tail].
    const engineC = makeEngine(dir);
    const replayed = (engineC as any).sessionManager.resume(sessionId);
    const texts = replayed.transcript
      .toMessages()
      .map((m: { content: unknown }) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("十轮旧对话的迁移摘要");
    expect(texts[1]).toContain(summaryFor(1));
    expect(texts[2]).toBe("切片二边界");
    expect(texts.some((x: string) => x.includes("旧消息"))).toBe(false);
    expect(texts.some((x: string) => x.includes("新话题第一句"))).toBe(false);
  });

  it("second closure in one process summarizes the right window, not the trimmed tail", async () => {
    // Bug 2 reproduction: after the first archival trims the in-process
    // list, a second closure's stale raw range would clamp onto the WRONG
    // tail messages — and if the summary passes the 50-char gate it gets
    // persisted against the CORRECT anchors, permanently replacing the real
    // span with a summary of unrelated content.
    const engine = makeEngine(dir);
    const bundle = (engine as any).sessionManager.create(dir, "fake-model", fakeProvider);
    const sessionId = bundle.state.sessionId;
    bundle.transcript.appendMessage("user", "话题一开场白", { clientMessageId: "s1" });
    bundle.transcript.appendMessage("assistant", "回复一");
    bundle.transcript.appendMessage("user", "话题二开场白", { clientMessageId: "s2" });
    bundle.transcript.appendMessage("assistant", "回复二");
    bundle.transcript.appendMessage("user", "话题三开场白", { clientMessageId: "s3" });
    bundle.transcript.appendMessage("assistant", "回复三尾巴");

    const first = await engine.archiveTurnRange(
      sessionId,
      { start: 100, end: 120 }, // stale
      { fromClientMessageId: "s1", toClientMessageId: "s2", segmentId: "seg-1" },
    );
    expect(first.after).not.toBe(first.before);
    const second = await engine.archiveTurnRange(
      sessionId,
      { start: 200, end: 220 }, // stale
      { fromClientMessageId: "s2", toClientMessageId: "s3", segmentId: "seg-2" },
    );
    expect(second.after).not.toBe(second.before);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("话题一开场白");
    expect(prompts[0]).toContain("回复一");
    // The second prompt covers exactly [s2, s3): the second span's text and
    // NOT the unrelated tail (which is what the stale range would clamp to).
    expect(prompts[1]).toContain("话题二开场白");
    expect(prompts[1]).toContain("回复二");
    expect(prompts[1]).not.toContain("话题三开场白");
    expect(prompts[1]).not.toContain("回复三尾巴");
    expect(prompts[1]).not.toContain("话题一开场白");

    // Both markers persisted with their own summaries.
    const session = (engine as any).sessionManager.resume(sessionId);
    const events = session.transcript.getEvents("range_archive");
    expect(events).toHaveLength(2);
    expect(String(events[0]!.data.summary)).toContain(summaryFor(1));
    expect(String(events[1]!.data.summary)).toContain(summaryFor(2));

    // Restart replay: both summaries + remainder.
    const engineB = makeEngine(dir);
    const replayed = (engineB as any).sessionManager.resume(sessionId);
    const texts = replayed.transcript
      .toMessages()
      .map((m: { content: unknown }) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain(summaryFor(1));
    expect(texts[1]).toContain(summaryFor(2));
    expect(texts[2]).toBe("话题三开场白");
    expect(texts[3]).toBe("回复三尾巴");
  });

  it("fails open when the to-anchor is unresolvable in the live list", async () => {
    const engine = makeEngine(dir);
    const bundle = (engine as any).sessionManager.create(dir, "fake-model", fakeProvider);
    const sessionId = bundle.state.sessionId;
    bundle.transcript.appendMessage("user", "早期话题", { clientMessageId: "m1" });
    bundle.transcript.appendMessage("assistant", "早期回复");
    bundle.transcript.appendMessage("user", "当前边界", { clientMessageId: "m2" });
    bundle.transcript.appendMessage("assistant", "当前回复");
    await engine.appendArchiveMarker(sessionId, {
      summary: "早期话题的摘要",
      toClientMessageId: "m2",
      segmentId: "seg-a",
    });

    // "m1" exists in the raw transcript (hasClientMessageId is true) but it
    // was swallowed into seg-a's archived span, so it does NOT resolve in
    // the live replay — the anchored window cannot be built. Fail open:
    // no summarization, no persistence, before === after.
    const result = await engine.archiveTurnRange(
      sessionId,
      { start: 0, end: 2 },
      { toClientMessageId: "m1", segmentId: "seg-x" },
    );
    expect(result.after).toBe(result.before);
    expect(prompts).toHaveLength(0);
    const session = (engine as any).sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(1);
  });

  it("fails open on a degenerate anchored window (end <= start)", async () => {
    const engine = makeEngine(dir);
    const bundle = (engine as any).sessionManager.create(dir, "fake-model", fakeProvider);
    const sessionId = bundle.state.sessionId;
    bundle.transcript.appendMessage("user", "话题甲", { clientMessageId: "m1" });
    bundle.transcript.appendMessage("assistant", "回复甲");
    bundle.transcript.appendMessage("user", "话题乙", { clientMessageId: "m2" });

    const result = await engine.archiveTurnRange(
      sessionId,
      { start: 0, end: 2 },
      { fromClientMessageId: "m2", toClientMessageId: "m2", segmentId: "seg-degen" },
    );
    expect(result.after).toBe(result.before);
    expect(prompts).toHaveLength(0);
    const session = (engine as any).sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(0);
  });

  it("a from-less window merge-feeds the previously replayed anchored summary", async () => {
    // Merge composition: a from-less window [0, end) over the LIVE list
    // includes the previously replayed anchored-summary message at the head,
    // so summarizeRange's extractAnchoredSummary(window) merge-feeds it into
    // the new summary — which is exactly why the transcript layer's
    // last-wins rule for competing from-less markers loses nothing.
    const engineA = makeEngine(dir);
    const bundle = (engineA as any).sessionManager.create(dir, "fake-model", fakeProvider);
    const sessionId = bundle.state.sessionId;
    bundle.transcript.appendMessage("user", "早期话题甲", { clientMessageId: "e1" });
    bundle.transcript.appendMessage("assistant", "早期回复");
    bundle.transcript.appendMessage("user", "边界消息乙", { clientMessageId: "b1" });
    bundle.transcript.appendMessage("assistant", "中期回复");
    bundle.transcript.appendMessage("user", "边界消息丙", { clientMessageId: "b2" });
    await engineA.appendArchiveMarker(sessionId, {
      summary: "迁移摘要独特标记QQXX，覆盖最早期的全部对话内容，长度足够超过五十个字符以通过校验门槛。",
      toClientMessageId: "b1",
      segmentId: "migration-v1",
    });

    // Restart, then archive from-less up to the later boundary.
    const engineB = makeEngine(dir);
    const result = await engineB.archiveTurnRange(
      sessionId,
      { start: 340, end: 365 }, // stale
      { toClientMessageId: "b2", segmentId: "seg-2" },
    );
    expect(result.after).not.toBe(result.before);

    // The SOURCE window of the new summary contained marker A's summary —
    // both as the replayed head message and as the merge-fed prior summary.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("QQXX");
    expect(prompts[0]).toContain("=== Prior summary ===");
    expect(prompts[0]).toContain("边界消息乙");

    const session = (engineB as any).sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(2);

    // Replay after restart uses the LATER from-less marker (last-wins).
    const engineC = makeEngine(dir);
    const replayed = (engineC as any).sessionManager.resume(sessionId);
    const texts = replayed.transcript
      .toMessages()
      .map((m: { content: unknown }) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain(ANCHORED_OPEN);
    expect(texts[0]).toContain(summaryFor(1));
    expect(texts[1]).toBe("边界消息丙");
    expect(texts.some((x: string) => x.includes("早期话题甲"))).toBe(false);
    expect(texts.some((x: string) => x.includes("边界消息乙"))).toBe(false);
  });
});
