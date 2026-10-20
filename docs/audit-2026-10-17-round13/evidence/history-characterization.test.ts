import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { fmtTokens, modelTags } from "../../../packages/tui/src/ui/components/model-display.ts";

// Only owned temporary HOME paths are presented to the actual history module.
// Keep the rest of node:os intact. No TUI/Ink/TTY or model/provider imports.
const originalOs = { ...os };
const testRoot = mkdtempSync(join(os.tmpdir(), "codeshell-audit-r13-history-"));
let mockedHome = testRoot;
let sequence = 0;
mock.module("node:os", () => ({ ...originalOs, homedir: () => mockedHome }));
type History = typeof import("../../../packages/tui/src/ui/input-history.ts");
type Stored = { display: string; timestamp: number; project: string; sessionId: string };

async function freshHistory(entries: Stored[] = []): Promise<{ history: History; file: string }> {
  mockedHome = join(testRoot, String(++sequence));
  const dir = join(mockedHome, ".code-shell");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "history.jsonl");
  if (entries.length) writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const history = await import(`../../../packages/tui/src/ui/input-history.ts?historyAudit=${sequence}`) as History;
  history.initHistory("current", "/owned-project");
  return { history, file };
}
function entry(display: string, timestamp: number, sessionId = "previous", project = "/owned-project"): Stored {
  return { display, timestamp, sessionId, project };
}
function diskDisplays(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).display);
}
const drainTick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterAll(async () => {
  await drainTick();
  rmSync(testRoot, { recursive: true, force: true });
  mock.restore();
});

describe("ordinary input-history contracts under an owned temporary HOME", () => {
  test("control: old-session navigation is newest first and restores the draft", async () => {
    const { history } = await freshHistory([
      entry("older input", 1), entry("newer input", 2), entry("different project", 3, "other", "/unrelated-project"),
    ]);
    const nav = history.createHistoryNavigator();
    expect(nav.up("unfinished draft")).toBe("newer input");
    expect(nav.up("ignored while browsing")).toBe("older input");
    expect(nav.up("")).toBeNull();
    expect(nav.down()).toBe("newer input");
    expect(nav.down()).toBe("unfinished draft");
    expect(history.getTimestampedHistory().map((e) => e.display)).toEqual(["newer input", "older input"]);
  });

  test("HIST-R13-01: a newly submitted current-session input is behind the previous session on Up", async () => {
    const { history, file } = await freshHistory([entry("previous session input", 1)]);
    history.addToHistory("current session input");
    history.flushHistorySync();
    const nav = history.createHistoryNavigator();
    const first = nav.up("unfinished draft");
    const second = nav.up("");
    expect(first).toBe("previous session input");
    expect(second).toBe("current session input");
    expect(nav.down()).toBe("previous session input");
    expect(nav.down()).toBe("unfinished draft");
    expect(history.getTimestampedHistory()[0]!.display).toBe("current session input");
    expect(diskDisplays(file)).toEqual(["previous session input", "current session input"]);
    console.log("HIST-R13-01", JSON.stringify({ first, second, newestTimestamped: history.getTimestampedHistory()[0]!.display }));
  });

  test("HIST-R13-02: a navigator refreshed at submit retains an entry after ordinary interruption removal", async () => {
    const { history, file } = await freshHistory([entry("kept input", 1, "current")]);
    const nav = history.createHistoryNavigator();
    history.addToHistory("interrupted input");
    nav.refresh(); // CommandInput.handleSubmit sequence.
    history.flushHistorySync(); // The usual case: input persisted before later Esc.
    history.removeLastFromHistory(); // App's interruption bookkeeping call.
    const timestamped = history.getTimestampedHistory().map((e) => e.display);
    const staleUp = nav.up("");
    const freshUp = history.createHistoryNavigator().up("");
    expect(timestamped).toEqual(["kept input"]);
    expect(staleUp).toBe("interrupted input");
    expect(nav.up("")).toBe("kept input");
    expect(freshUp).toBe("kept input");
    nav.refresh();
    expect(nav.up("")).toBe("kept input");
    // Disk undo durability is observed, but no cross-process durability contract is assumed.
    expect(diskDisplays(file)).toEqual(["kept input", "interrupted input"]);
    console.log("HIST-R13-02", JSON.stringify({ timestamped, staleUp, freshUp, recoveryAfterRefresh: "kept input" }));
  });

  test("HIST-R13-C1: same-tick pending undo leaves future automatic flushes unscheduled; explicit flush recovers", async () => {
    const { history, file } = await freshHistory();
    history.addToHistory("removed before next tick");
    history.removeLastFromHistory();
    await drainTick();
    expect(diskDisplays(file)).toEqual([]);
    history.addToHistory("later ordinary input");
    await drainTick();
    expect(history.getTimestampedHistory().map((e) => e.display)).toEqual(["later ordinary input"]);
    expect(diskDisplays(file)).toEqual([]);
    history.flushHistorySync();
    expect(diskDisplays(file)).toEqual(["later ordinary input"]);
    console.log("HIST-R13-C1", JSON.stringify({ automaticDiskDisplays: [], explicitFlushDiskDisplays: diskDisplays(file) }));
  });

  test("control: a nonempty next-tick flush permits the following automatic flush", async () => {
    const { history, file } = await freshHistory();
    history.addToHistory("first ordinary input");
    await drainTick();
    expect(diskDisplays(file)).toEqual(["first ordinary input"]);
    history.addToHistory("second ordinary input");
    await drainTick();
    expect(diskDisplays(file)).toEqual(["first ordinary input", "second ordinary input"]);
    history.flushHistorySync();
  });
});

describe("existing model-display pure helper contracts", () => {
  test("documented compact token examples and common missing values", () => {
    expect(fmtTokens(128000)).toBe("128K");
    expect(fmtTokens(1000000)).toBe("1M");
    expect(fmtTokens(undefined)).toBe("?");
    expect(fmtTokens(0)).toBe("?");
    expect(fmtTokens(999)).toBe("999");
  });
  test("name-based tags are heuristic labels rather than provider capability evidence", () => {
    expect(modelTags("fast-coder", "reason-mini-free-max")).toEqual(["coding", "reasoning", "fast", "cheap", "powerful"]);
    expect(modelTags("plain", "neutral")).toEqual([]);
  });
});
