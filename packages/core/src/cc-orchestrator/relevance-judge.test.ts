import { describe, it, expect } from "bun:test";
import { judgeContinuation, parseJudgeResponse } from "./relevance-judge.js";

describe("parseJudgeResponse", () => {
  it("parses a stop decision", () => {
    const d = parseJudgeResponse('{"action":"stop","reason":"goal met"}');
    expect(d.action).toBe("stop");
  });
  it("parses continue-fresh with handoff summary", () => {
    const d = parseJudgeResponse('{"action":"continue-fresh","handoffSummary":"prev built X","reason":"unrelated next step"}');
    expect(d.action).toBe("continue-fresh");
    expect(d.handoffSummary).toBe("prev built X");
  });
  it("defaults to continue-same on unparseable output", () => {
    const d = parseJudgeResponse("garbage");
    expect(d.action).toBe("continue-same");
  });
});

describe("judgeContinuation", () => {
  it("calls the injected aux LLM with goal + lastResult + nextPrompt and returns parsed decision", async () => {
    let seenPrompt = "";
    const fakeLlm = async (prompt: string) => { seenPrompt = prompt; return '{"action":"stop","reason":"done"}'; };
    const d = await judgeContinuation({ goal: "all tests pass", lastResult: "tests green", nextPrompt: "rerun" }, fakeLlm);
    expect(d.action).toBe("stop");
    expect(seenPrompt).toContain("all tests pass");
    expect(seenPrompt).toContain("tests green");
  });
});
