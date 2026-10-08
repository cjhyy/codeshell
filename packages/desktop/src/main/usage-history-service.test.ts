import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageLedger, SessionManager } from "@cjhyy/code-shell-core";
import { readUsageHistory } from "./usage-history-service";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const sessionsDir = mkdtempSync(join(tmpdir(), "desktop-cost-history-"));
  directories.push(sessionsDir);
  const sessions = new SessionManager(sessionsDir);
  const ledger = new UsageLedger({ storageDir: join(sessionsDir, ".usage-ledger") });
  for (const sid of ["parent", "child", "other"]) {
    sessions.create("/workspace", "gpt-4o", "openai", sid, sid === "child" ? "parent" : null);
    const owner = ledger.owner(
      sid,
      "run-one",
      sid === "child" ? ["parent"] : [],
      "main",
      sessionsDir,
    );
    sessions.updateSessionState(sid, { costState: ledger.sessionState(sid, sessionsDir) });
    const receipt = ledger.begin(owner, {
      provider: sid === "other" ? "unknown-provider" : "openai",
      model: "gpt-4o",
    });
    ledger.settle(receipt, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    ledger.finish(receipt, "completed");
  }
  return { sessionsDir, sessions };
}
test("local Host history reads durable cross-session estimates and exact Session rollup without changing state", () => {
  const { sessionsDir } = fixture();
  const before = readFileSync(join(sessionsDir, "parent", "state.json"), "utf8");
  const all = readUsageHistory({ scope: "store" }, sessionsDir);
  expect(all.requests).toBe(3);
  expect(all.unknownCostRequests).toBe(1);
  expect(readUsageHistory({ scope: "session", sessionId: "parent" }, sessionsDir).requests).toBe(1);
  expect(
    readUsageHistory({ scope: "session", sessionId: "parent", includeChildren: true }, sessionsDir)
      .requests,
  ).toBe(2);
  expect(
    readUsageHistory({ scope: "session", sessionId: "parent", runId: "different-run" }, sessionsDir)
      .requests,
  ).toBe(0);
  expect(readFileSync(join(sessionsDir, "parent", "state.json"), "utf8")).toBe(before);
  expect(JSON.stringify(all)).not.toContain(sessionsDir);
});
test("history queries reject traversal and unbounded reads, and legacy counters cannot become known zero bills", () => {
  const { sessionsDir, sessions } = fixture();
  expect(() =>
    readUsageHistory({ scope: "session", sessionId: "../parent" }, sessionsDir),
  ).toThrow();
  expect(() => readUsageHistory({ limit: 10001 }, sessionsDir)).toThrow("Invalid usage query");
  expect(() => readUsageHistory({ scope: "runtime" }, sessionsDir)).toThrow(
    "Invalid history scope",
  );
  sessions.create("/workspace", "legacy", "legacy", "old-session");
  sessions.updateSessionState("old-session", {
    tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    costState: { oldTotal: 12 },
  });
  const old = readUsageHistory({ scope: "session", sessionId: "old-session" }, sessionsDir);
  expect(old.requests).toBe(0);
  expect(old.partial).toBe(true);
});
