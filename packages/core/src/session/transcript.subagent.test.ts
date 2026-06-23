import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript } from "./transcript.js";

/**
 * The "subagent" transcript anchor (replay-subagent-cards): spawning a
 * sub-agent writes one of these into the PARENT transcript so replay can
 * rebuild the sub-agent's card from sessions/<agentId>/. agentId === childSid.
 */
describe("Transcript.appendSubagent", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-tr-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a subagent anchor with agentId + description", () => {
    const t = new Transcript(join(dir, "transcript.jsonl"));
    t.appendSubagent("Ab3xK9q1", "导演", "分析 ep01 剧本");

    const events = t.getEvents("subagent");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("subagent");
    expect(events[0]!.data).toMatchObject({
      agentId: "Ab3xK9q1",
      name: "导演",
      description: "分析 ep01 剧本",
    });
  });

  it("survives reload from disk (replay reads it back)", () => {
    const file = join(dir, "transcript.jsonl");
    const t = new Transcript(file);
    t.appendSubagent("zNTH7ouA", undefined, "请对 ep01 复审");

    const reloaded = Transcript.loadFromFile(file);
    const events = reloaded.getEvents("subagent");
    expect(events).toHaveLength(1);
    expect(events[0]!.data.agentId).toBe("zNTH7ouA");
    expect(events[0]!.data.description).toBe("请对 ep01 复审");
    // name omitted at spawn (SubAgentSpawnRequest has no name) → undefined ok.
    expect(events[0]!.data.name).toBeUndefined();
  });
});
