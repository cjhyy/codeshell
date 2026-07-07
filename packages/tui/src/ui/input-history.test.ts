import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
