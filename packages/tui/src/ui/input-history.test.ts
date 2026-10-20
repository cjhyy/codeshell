import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type InputHistoryModule = typeof import("./input-history.js");

let mockedHome = tmpdir();
const tempHomes: string[] = [];

mock.module("node:os", () => ({
  homedir: () => mockedHome,
}));

async function loadInputHistory(home: string): Promise<InputHistoryModule> {
  mockedHome = home;
  return (await import(`./input-history.ts?cachebust=${Math.random()}`)) as InputHistoryModule;
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("input history sensitive commands", () => {
  test("does not persist inline /login secrets", async () => {
    const home = mkdtempSync(join(tmpdir(), "codeshell-history-home-"));
    tempHomes.push(home);
    const history = await loadInputHistory(home);

    history.initHistory("session-1", "/workspace");
    history.addToHistory("/login sk-test-secret");
    history.addToHistory("/login");
    history.addToHistory("/model gpt-5");
    history.flushHistorySync();

    const displays = history.getTimestampedHistory().map((entry) => entry.display);
    expect(displays).not.toContain("/login sk-test-secret");
    expect(displays).toContain("/login");
    expect(displays).toContain("/model gpt-5");

    const historyFile = join(home, ".code-shell", "history.jsonl");
    const onDisk = existsSync(historyFile) ? readFileSync(historyFile, "utf-8") : "";
    expect(onDisk).not.toContain("sk-test-secret");
  });
});

function homeWithPreviousSession(display: string): string {
  const home = mkdtempSync(join(tmpdir(), "codeshell-history-home-"));
  tempHomes.push(home);
  mkdirSync(join(home, ".code-shell"));
  const entry = { display, timestamp: 1, project: "/workspace", sessionId: "previous" };
  writeFileSync(join(home, ".code-shell", "history.jsonl"), `${JSON.stringify(entry)}\n`);
  return home;
}

describe("input history navigation", () => {
  test("Up returns the current session's newest input before older sessions", async () => {
    const history = await loadInputHistory(homeWithPreviousSession("previous input"));
    history.initHistory("current", "/workspace");
    history.addToHistory("current input");

    const navigator = history.createHistoryNavigator();
    expect(navigator.up("")).toBe("current input");
    expect(navigator.up("")).toBe("previous input");
    expect(navigator.up("")).toBeNull();
    expect(navigator.down()).toBe("current input");
  });

  test("an existing navigator stops returning an input removed after interrupt", async () => {
    const history = await loadInputHistory(homeWithPreviousSession("previous input"));
    history.initHistory("current", "/workspace");
    const navigator = history.createHistoryNavigator();
    history.addToHistory("kept input");
    navigator.refresh();
    history.flushHistorySync();
    // Flushed removals are keyed by timestamp; real submissions are not in the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    history.addToHistory("interrupted input");
    navigator.refresh();
    history.flushHistorySync();

    history.removeLastFromHistory();

    expect(navigator.up("draft")).toBe("kept input");
    expect(navigator.up("draft")).toBe("previous input");
    expect(navigator.down()).toBe("kept input");
    expect(navigator.down()).toBe("draft");
  });
});
