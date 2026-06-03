import { describe, test, expect } from "bun:test";
import { InvestigationGuard } from "./investigation-guard.js";
import type { ToolCall } from "../types.js";

function readCall(): ToolCall {
  return {
    id: "t1",
    toolName: "Read",
    args: { file_path: "/repo/src/foo.ts", offset: 0 },
  };
}

describe("InvestigationGuard — soft-mode suppresses dedupe hard-block (read-only sessions)", () => {
  test("3rd repeated read yields no block when soft-mode is on", () => {
    const g = new InvestigationGuard();
    g.setSoftMode(true);
    let last;
    for (let i = 0; i < 3; i++) {
      last = g.preToolCheck(readCall());
    }
    expect(last?.block).toBeUndefined();
  });

  test("control: same reads WITHOUT soft-mode DO hard-block by the 3rd", () => {
    const g = new InvestigationGuard();
    let last;
    for (let i = 0; i < 3; i++) {
      last = g.preToolCheck(readCall());
    }
    expect(last?.block).toBeDefined();
  });

  test("read-only-review policy does not suggest side effects after read budget", () => {
    const g = new InvestigationGuard();
    g.setPolicy("read-only-review");
    let last;
    for (let i = 0; i < 4; i++) {
      last = g.preToolCheck({
        id: `g${i}`,
        toolName: "Grep",
        args: { pattern: `p${i}`, path: "/repo" },
      });
    }
    expect(last?.prepend).toContain("explicit read-only review");
    expect(last?.prepend).not.toContain("make a code change");
    expect(last?.prepend).not.toContain("run a command with side effects");
    expect(last?.prepend).not.toContain("ask the user");
  });

  test("read-only-review silent-turn reminder asks for status, not side effects", () => {
    const g = new InvestigationGuard();
    g.setPolicy("read-only-review");
    g.turnEnded(1);
    g.turnEnded(2);
    const reminder = g.turnEnded(3);
    expect(reminder).toContain("read-only investigation");
    expect(reminder).toContain("status update");
    expect(reminder).not.toContain("Bash");
    expect(reminder).not.toContain("side-effecting action");
    expect(reminder).not.toContain("verify at runtime");
  });
});
