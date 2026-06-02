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
});
