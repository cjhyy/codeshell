import { describe, expect, it } from "bun:test";
import { agentSendInputToolDef, agentToolDef } from "../tool-system/builtin/agent.js";
import { loadSection } from "./section-loader.js";

const orchestration = loadSection("orchestration");
const guidance = [
  ["Agent", agentToolDef.description],
  ["AgentSendInput", agentSendInputToolDef.description],
  ["orchestration", orchestration],
] as const;

describe("sub-agent reuse guidance", () => {
  it("requires a self-contained first task while advertising later continuation", () => {
    for (const text of [agentToolDef.description, orchestration]) {
      expect(text).toMatch(/self-contained/i);
      expect(text).toContain("AgentSendInput");
    }
  });

  for (const [surface, text] of guidance) {
    it(`${surface} does not deny continuation or promise unlimited memory`, () => {
      expect(text).not.toMatch(
        /it is stateless|cannot send follow-up messages|WITH FULL MEMORY|so nothing is lost/i,
      );
    });
  }

  it("uses saved context and incremental instructions for continuation", () => {
    for (const text of [agentSendInputToolDef.description, orchestration]) {
      expect(text).toMatch(/saved (?:context|transcript)/i);
      expect(text).toMatch(/incremental/i);
    }
  });

  it("guides related work back to an existing agent and independent work to a new one", () => {
    expect(orchestration).toMatch(/related follow-up work, prefer `AgentSendInput`/i);
    expect(orchestration).toMatch(/new `Agent` for an independent task/i);
    expect(orchestration).toMatch(/context can be compacted or limited/i);
  });

  it("documents the supported running-agent delivery choices", () => {
    const properties = agentSendInputToolDef.inputSchema.properties as Record<
      string,
      { enum: string[] }
    >;
    const delivery = properties.delivery;
    expect(delivery.enum).toEqual(["next-safe-point", "interrupt-and-redrive"]);
    for (const mode of delivery.enum) {
      expect(orchestration).toContain(mode);
    }
    expect(orchestration).toMatch(/default `next-safe-point`/);
    expect(orchestration).toMatch(/interrupt-and-redrive` only when/);
  });
});
