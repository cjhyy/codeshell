import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../logging/sanitize-messages.js";
import { MemoryManager } from "../session/memory.js";
import type { ExtractedMemory } from "./extract-memories.js";
import { MemoryOrchestrator } from "./memory-orchestrator.js";
import { joinMemoryPrompt, type MemoryPromptCachePlan } from "./memory-prompt-segments.js";
import {
  buildWriteDecisionPromptSegments,
  type WriteDecisionMemory,
} from "./memory-write-decision-prompt.js";

const CATALOGUE = "Existing memories catalogue (JSON lines):\n";
const CANDIDATE = "\nCandidate:\n";
const EXCERPTS = "Body excerpts of related memories (JSON lines):\n";
const RESPONSE = "\n\nRespond with JSON:";

function stored(index: number, bodyChars: number): WriteDecisionMemory {
  return {
    id: `mem-${index}`,
    name: `topic ${index}`,
    type: "project",
    description: `description ${index} ${"d".repeat(60)}`,
    location: index % 2 ? "global" : "project",
    memoryScope: "dream",
    origin: index % 3 ? "auto" : "manual",
    entry: {
      fileName: `topic-${index}.md`,
      createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      content: `BODY_${index} ${"y".repeat(bodyChars)}`,
    },
  };
}

const store = Array.from({ length: 30 }, (_, index) => stored(index, index % 4 ? 2_400 : 300));
const candidate = (name: string): ExtractedMemory => ({
  type: "project",
  scope: "project",
  name,
  description: `${name} description`,
  content: `${name} content`,
});
/** A ranking as rankRelated would produce for some candidate: any order. */
const ranked = (seed: number) =>
  [...store].sort((a, b) => ((store.indexOf(a) * seed) % 31) - ((store.indexOf(b) * seed) % 31));

const lines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
const catalogueOf = (prompt: string) => prompt.split(CATALOGUE)[1]!.split(CANDIDATE)[0]!;
const excerptsOf = (prompt: string) => lines(prompt.split(EXCERPTS)[1]!.split(RESPONSE)[0]!);

/** The pre-change rendering rule: rank order, 1,500 per body, 8,000 in total. */
function legacyRelatedLines(related: WriteDecisionMemory[]) {
  let remaining = 8_000;
  return related.map((memory) => {
    const body = redactSecrets(memory.entry.content);
    const excerpt = body.slice(0, Math.min(1_500, remaining));
    remaining -= excerpt.length;
    return {
      id: memory.id,
      location: memory.location,
      scope: memory.memoryScope,
      origin: memory.origin,
      type: memory.type,
      name: memory.name,
      description: redactSecrets(memory.description),
      bodyExcerpt: {
        text: excerpt,
        status:
          excerpt.length === body.length
            ? "complete"
            : excerpt.length > 0
              ? "truncated"
              : "omitted",
        totalChars: body.length,
      },
    };
  });
}

describe("memory write-decision prompt", () => {
  test("carries the same metadata and body excerpts as the ranked rendering did", () => {
    const related = ranked(7).slice(0, 20);
    const prompt = joinMemoryPrompt(
      buildWriteDecisionPromptSegments(candidate("alpha"), store, related),
    );
    const catalogue = new Map(lines(catalogueOf(prompt)).map((line) => [line.id, line]));
    const excerpts = excerptsOf(prompt);
    const legacy = legacyRelatedLines(related);

    for (const { bodyExcerpt: _bodyExcerpt, ...metadata } of legacy) {
      expect(catalogue.get(metadata.id)).toEqual(metadata);
    }
    const withBody = legacy.filter((line) => line.bodyExcerpt.status !== "omitted");
    expect(withBody.length).toBeLessThan(legacy.length);
    expect(excerpts).toEqual(withBody.map(({ id, bodyExcerpt }) => ({ id, bodyExcerpt })));
    expect(excerpts.reduce((sum, line) => sum + line.bodyExcerpt.text.length, 0)).toBe(8_000);
    // The ranking itself stays visible, including entries without a body.
    expect(
      JSON.parse(prompt.split("Related catalogue ids, most similar first:\n")[1]!.split("\n")[0]!),
    ).toEqual(related.map((memory) => memory.id));
    expect(prompt).toContain("Missing text is not evidence");
    expect(prompt).toContain("without a body excerpt");
    expect(JSON.parse(prompt.split("Candidate:\n")[1]!.split("\n\nRelated")[0]!).name).toBe(
      "alpha",
    );
  });

  test("two candidates against one store share the prefix through the whole catalogue", () => {
    const one = buildWriteDecisionPromptSegments(candidate("alpha"), store, ranked(7).slice(0, 20));
    const two = buildWriteDecisionPromptSegments(
      candidate("beta"),
      [...store].reverse(),
      ranked(11).slice(0, 20),
    );

    expect(one.stable.length).toBeGreaterThan(2);
    expect(two.stable).toEqual(one.stable);
    expect(one.stable.join("")).not.toContain("alpha");
    const [promptOne, promptTwo] = [joinMemoryPrompt(one), joinMemoryPrompt(two)];
    const shared = promptOne.indexOf(CANDIDATE);
    expect(promptTwo.slice(0, shared)).toBe(promptOne.slice(0, shared));
    expect(lines(catalogueOf(promptOne)).map((line) => line.id)).toEqual(
      store.map((memory) => memory.id),
    );
    // Only a short remainder of the catalogue is outside the stable messages.
    expect(one.volatile.indexOf(CANDIDATE)).toBeLessThan(2_400);
  });

  test("a new memory is appended without changing earlier catalogue bytes", () => {
    const before = buildWriteDecisionPromptSegments(candidate("alpha"), store, ranked(7));
    const added = { ...stored(30, 100), entry: { ...stored(30, 100).entry, createdAt: undefined } };
    const newest = stored(31, 100);
    const after = buildWriteDecisionPromptSegments(
      candidate("beta"),
      [newest, added, ...store],
      ranked(3),
    );

    expect(after.stable.slice(0, before.stable.length)).toEqual(before.stable);
    const catalogue = catalogueOf(joinMemoryPrompt(after));
    expect(catalogue).toStartWith(catalogueOf(joinMemoryPrompt(before)));
    // No creation time sorts before dated entries would break the prefix, so it sorts last.
    expect(
      lines(catalogue)
        .map((line) => line.id)
        .slice(-2),
    ).toEqual(["mem-31", "mem-30"]);
  });
});

describe("MemoryOrchestrator write-decision cache plan", () => {
  test("sequential candidates in one run reuse the catalogue after an ADD", async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-memory-decision-cache-"));
    try {
      const storage = { baseDir: join(root, "store"), projectDir: join(root, "workspace") };
      const dream = new MemoryManager({ ...storage, scope: "dream" });
      for (let index = 0; index < 24; index++) {
        dream.save({
          type: "project",
          name: `stored topic ${index}`,
          description: `stored description ${index} ${"d".repeat(80)}`,
          content: `stored body ${index}`,
          origin: "auto",
          createdAt: `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        });
      }
      const plans: Array<{ prompt: string; cache?: MemoryPromptCachePlan }> = [];
      await new MemoryOrchestrator({
        memoryManager: new MemoryManager(storage),
        callLLM: async (system, prompt, options) => {
          if (!system.includes("write decision"))
            return system.includes("summariser")
              ? "{}"
              : JSON.stringify([candidate("fresh one"), candidate("fresh two")]);
          plans.push({ prompt, cache: options?.cache });
          return JSON.stringify({ action: "ADD" });
        },
      }).run([{ role: "user", content: "remember" }], "decision-cache");

      expect(plans).toHaveLength(2);
      const [one, two] = plans as [(typeof plans)[0], (typeof plans)[0]];
      for (const plan of plans) {
        expect(plan.cache?.purpose).toBe("memory-write-decision");
        expect(joinMemoryPrompt(plan.cache!)).toBe(plan.prompt);
      }
      expect(dream.loadAll()).toHaveLength(26);
      expect(one.cache!.stable.length).toBeGreaterThan(2);
      expect(two.cache!.stable.slice(0, one.cache!.stable.length)).toEqual(one.cache!.stable);
      expect(catalogueOf(two.prompt)).toStartWith(catalogueOf(one.prompt));
      expect(catalogueOf(two.prompt)).toContain("fresh one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
