import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptComposer } from "./composer.js";
import { dateChangeNotice, localDateYmd, resolveSessionDates } from "./session-date.js";
import { createRunContextLedger, engineContextSections } from "../engine/run-context-ledger.js";
import { LEDGER_UPDATE_PREAMBLE } from "../context/context-ledger.js";
import { Transcript } from "../session/transcript.js";
import type { Message } from "../types.js";

// Local-time constructors: the head states the LOCAL date, whatever the zone.
const evening = new Date(2026, 10, 12, 23, 50);
const afterMidnight = new Date(2026, 10, 13, 0, 10);
const laterThatDay = new Date(2026, 10, 13, 18, 0);

describe("session dates", () => {
  it("formats the local date, zero padded", () => {
    expect(localDateYmd(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDateYmd(evening)).toBe("2026-11-12");
  });

  it("freezes the head date at the session start and reports a later today", () => {
    expect(resolveSessionDates(evening.getTime(), evening)).toEqual({ headDate: "2026-11-12" });
    expect(resolveSessionDates(evening.getTime(), afterMidnight)).toEqual({
      headDate: "2026-11-12",
      changedTo: "2026-11-13",
    });
  });

  it("uses today when the session start is unknown or unusable", () => {
    expect(resolveSessionDates(undefined, afterMidnight)).toEqual({ headDate: "2026-11-13" });
    expect(resolveSessionDates(Number.NaN, afterMidnight)).toEqual({ headDate: "2026-11-13" });
  });
});

describe("PromptComposer session date", () => {
  let cwd: string;
  let prevHome: string | undefined;
  let home: string;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-date-home-"));
    process.env.HOME = home;
    cwd = mkdtempSync(join(tmpdir(), "cs-date-"));
    writeFileSync(join(cwd, "CODESHELL.md"), "project instructions\n");
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const composerAt = (now: Date, sessionStartedAt?: number) =>
    new PromptComposer({ cwd, model: "test-model", sessionStartedAt, now: () => now });

  it("keeps today's wording for a session that started today", () => {
    const withStart = composerAt(evening, evening.getTime()).buildUserContextMessage();
    const withoutStart = composerAt(evening).buildUserContextMessage();
    expect(withStart).toEqual(withoutStart);
    expect(withStart!.content as string).toStartWith(
      "<system-reminder>\nToday's date is 2026-11-12.\n\n",
    );
    expect(composerAt(evening, evening.getTime()).buildDateChangeNotice()).toBe("");
  });

  it("keeps the head message byte-identical across midnight", () => {
    const started = evening.getTime();
    const before = composerAt(evening, started).buildUserContextMessage();
    const after = composerAt(afterMidnight, started).buildUserContextMessage();
    const later = composerAt(laterThatDay, started).buildUserContextMessage();
    expect(after).toEqual(before);
    expect(later).toEqual(before);
    expect(composerAt(afterMidnight, started).buildDateChangeNotice()).toBe(
      dateChangeNotice("2026-11-13"),
    );
    expect(dateChangeNotice("2026-11-13")).toContain("2026-11-13");
  });

  it("announces no date when there is no head message stating one", () => {
    const composer = new PromptComposer({
      cwd,
      model: "test-model",
      disableInstructions: true,
      sessionStartedAt: evening.getTime(),
      now: () => afterMidnight,
    });
    expect(composer.buildUserContextMessage()).toBeNull();
    expect(composer.buildDateChangeNotice()).toBe("");
  });

  describe("through the context ledger", () => {
    const started = evening.getTime();
    /** One run: the ledger sections as the engine builds them, synced once. */
    const run = (
      transcript: Transcript,
      messages: Message[],
      now: Date,
      extra: { key: string; text: string }[],
    ): Message | undefined =>
      createRunContextLedger({
        transcript,
        sections: [
          ...extra,
          ...engineContextSections({
            mcpFailureSummary: "",
            dateChange: composerAt(now, started).buildDateChangeNotice(),
          }),
        ],
      }).sync(messages);

    it("announces a new date once, as an update next to other context", () => {
      const transcript = Transcript.inMemory("date-ledger-update");
      const messages: Message[] = [];
      const other = [{ key: "capability", text: "stable capability context" }];

      const first = run(transcript, messages, evening, other);
      expect(first!.content).toContain("stable capability context");
      expect(first!.content).not.toContain("2026-11-13");

      const second = run(transcript, messages, afterMidnight, other);
      expect(second!.content).toContain(LEDGER_UPDATE_PREAMBLE);
      expect(second!.content).toContain(dateChangeNotice("2026-11-13"));
      expect(second!.content).not.toContain("stable capability context");

      // A third run on the same new date has nothing to add.
      expect(run(transcript, messages, laterThatDay, other)).toBeUndefined();
      expect(messages).toEqual([first!, second!]);
    });

    it("announces a new date once when it is the only context", () => {
      const transcript = Transcript.inMemory("date-ledger-only");
      const messages: Message[] = [];

      expect(run(transcript, messages, evening, [])).toBeUndefined();
      const second = run(transcript, messages, afterMidnight, []);
      expect(second!.content).toContain(dateChangeNotice("2026-11-13"));
      expect(run(transcript, messages, laterThatDay, [])).toBeUndefined();
      expect(messages).toEqual([second!]);
    });

    it("supersedes the announced date when the date changes again", () => {
      const transcript = Transcript.inMemory("date-ledger-again");
      const messages: Message[] = [];
      run(transcript, messages, afterMidnight, []);
      const next = run(transcript, messages, new Date(2026, 10, 14, 9, 0), []);
      expect(next!.content).toContain(LEDGER_UPDATE_PREAMBLE);
      expect(next!.content).toContain(dateChangeNotice("2026-11-14"));
      expect(next!.content).not.toContain("2026-11-13");
    });
  });
});
