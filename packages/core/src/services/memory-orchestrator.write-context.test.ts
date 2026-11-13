import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../session/memory.js";
import type { ExtractedMemory } from "./extract-memories.js";
import { MemoryOrchestrator } from "./memory-orchestrator.js";

interface ComparedMemory {
  id: string;
  location: "project" | "global";
  scope: "user" | "dream";
  origin: "manual" | "auto" | "dream";
  name: string;
  bodyExcerpt: { text: string; status: "complete" | "truncated" | "omitted"; totalChars: number };
}

/**
 * The related memories as the model sees them, most similar first: catalogue
 * metadata joined by id with the body excerpt that follows the candidate. A
 * related entry without an excerpt line has its body omitted.
 */
function comparedMemories(prompt: string): ComparedMemory[] {
  const jsonLines = (text: string) =>
    text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  const catalogue = jsonLines(
    prompt.split("Existing memories catalogue (JSON lines):\n")[1]!.split("\nCandidate:\n")[0]!,
  );
  const excerpts = jsonLines(
    prompt
      .split("Body excerpts of related memories (JSON lines):\n")[1]!
      .split("\n\nRespond with JSON:")[0]!,
  );
  const ranked: string[] = JSON.parse(
    prompt.split("Related catalogue ids, most similar first:\n")[1]!.split("\n")[0]!,
  );
  return ranked.map((id) => ({
    ...catalogue.find((memory) => memory.id === id),
    bodyExcerpt: excerpts.find((memory) => memory.id === id)?.bodyExcerpt ?? {
      text: "",
      status: "omitted",
    },
  }));
}

const first: ExtractedMemory = {
  type: "project",
  scope: "project",
  name: "package-manager",
  description: "Project package manager policy",
  content: "Use Bun for the project.",
};
const updated: ExtractedMemory = {
  ...first,
  name: "package-manager-policy",
  content: "Use Bun for the project and commit its lockfile.",
};

async function withStorage(
  run: (storage: { baseDir: string; projectDir: string }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "cs-memory-write-context-"));
  try {
    await run({ baseDir: join(root, "isolated-store"), projectDir: join(root, "workspace") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("MemoryOrchestrator current batch write context", () => {
  for (const projectScoped of [true, false]) {
    it(`lets a later candidate update a just-added ID (${projectScoped ? "project" : "root-only"} storage)`, async () => {
      await withStorage(async ({ baseDir, projectDir }) => {
        const storage = { baseDir, projectDir: projectScoped ? projectDir : undefined };
        const dream = new MemoryManager({ ...storage, scope: "dream" });
        let addedId: string | undefined;
        await new MemoryOrchestrator({
          memoryManager: new MemoryManager(storage),
          callLLM: async (system, prompt) => {
            if (!system.includes("write decision")) return JSON.stringify([first, updated]);
            const previous = comparedMemories(prompt).find((memory) => memory.name === first.name)!;
            expect(previous.bodyExcerpt).toEqual({
              text: first.content,
              status: "complete",
              totalChars: first.content.length,
            });
            addedId = previous.id;
            return JSON.stringify({ action: "UPDATE", target: previous });
          },
        }).run([{ role: "user", content: "Remember the package manager policy" }], "batch-add");

        expect(addedId).toBeDefined();
        expect(dream.loadAll()).toHaveLength(1);
        expect(dream.findById(addedId!)!).toMatchObject({
          name: updated.name,
          content: updated.content,
          origin: "auto",
          updateCount: 1,
        });
      });
    });
  }

  it("compares subsequent candidates with an updated body and title", async () => {
    await withStorage(async (storage) => {
      const dream = new MemoryManager({ ...storage, scope: "dream" });
      dream.save({ ...first, id: "existing-policy", origin: "dream" });
      let decisions = 0;
      await new MemoryOrchestrator({
        memoryManager: new MemoryManager(storage),
        callLLM: async (system, prompt) => {
          if (!system.includes("write decision")) {
            return JSON.stringify([updated, { ...updated, name: "package-manager-reminder" }]);
          }
          const previous = comparedMemories(prompt).find(
            (memory) => memory.id === "existing-policy",
          )!;
          if (decisions++ === 0) {
            expect(previous.bodyExcerpt.text).toBe(first.content);
            return JSON.stringify({ action: "UPDATE", target: previous });
          }
          expect(previous.name).toBe(updated.name);
          expect(previous.bodyExcerpt.text).toBe(updated.content);
          return JSON.stringify({ action: "NOOP" });
        },
      }).run([{ role: "user", content: "Remember the package manager policy" }], "batch-update");

      expect(decisions).toBe(2);
      expect(dream.loadAll()).toHaveLength(1);
      expect(dream.findById("existing-policy")!).toMatchObject({
        content: updated.content,
        origin: "dream",
        updateCount: 1,
      });
    });
  });

  it("removes deleted IDs and bodies from later decisions", async () => {
    await withStorage(async (storage) => {
      const dream = new MemoryManager({ ...storage, scope: "dream" });
      dream.save({ ...first, id: "obsolete-policy", origin: "auto" });
      dream.save({
        ...first,
        id: "retained-reference",
        name: "artifact-directory",
        description: "Release artifact storage",
        content: "Save release artifacts outside the checkout.",
        origin: "auto",
      });
      let decisions = 0;
      await new MemoryOrchestrator({
        memoryManager: new MemoryManager(storage),
        callLLM: async (system, prompt) => {
          if (!system.includes("write decision")) {
            return JSON.stringify([updated, { ...first, name: "new-package-manager" }]);
          }
          const previous = comparedMemories(prompt);
          if (decisions++ === 0) {
            return JSON.stringify({
              action: "DELETE",
              target: previous.find((memory) => memory.id === "obsolete-policy"),
            });
          }
          expect(previous.map((memory) => memory.id)).toEqual(["retained-reference"]);
          expect(prompt).not.toContain('"text":"Use Bun for the project."');
          return JSON.stringify({ action: "ADD" });
        },
      }).run([{ role: "user", content: "Remember the revised policies" }], "batch-delete");

      expect(decisions).toBe(2);
      expect(dream.findById("obsolete-policy")).toBeUndefined();
      expect(dream.findById("retained-reference")).toBeDefined();
      expect(dream.loadAll()).toHaveLength(2);
    });
  });

  it("reloads project evidence written by the global promotion gate", async () => {
    await withStorage(async (storage) => {
      const global = { ...first, type: "feedback", scope: "global" };
      let comparedEvidence = false;
      await new MemoryOrchestrator({
        memoryManager: new MemoryManager(storage),
        callLLM: async (system, prompt) => {
          if (!system.includes("write decision")) return JSON.stringify([global, updated]);
          const previous = comparedMemories(prompt)[0]!;
          expect(previous).toMatchObject({
            name: first.name,
            location: "project",
            scope: "dream",
            origin: "auto",
            bodyExcerpt: { text: first.content, status: "complete" },
          });
          comparedEvidence = true;
          return JSON.stringify({ action: "NOOP" });
        },
      }).run([{ role: "user", content: "Remember useful preferences" }], "batch-gate");

      expect(comparedEvidence).toBe(true);
      expect(new MemoryManager({ ...storage, scope: "dream" }).loadAll()).toHaveLength(1);
      expect(
        new MemoryManager({ baseDir: storage.baseDir, scope: "pending" }).loadAll(),
      ).toHaveLength(1);
      expect(
        new MemoryManager({ baseDir: storage.baseDir, scope: "dream" }).loadAll(),
      ).toHaveLength(0);
    });
  });

  it("still preserves distinct directions and numbers if a later decision fails", async () => {
    await withStorage(async (storage) => {
      const opposite = {
        ...first,
        content: "Use npm, not Bun, for the second project on port 4000.",
      };
      let decisions = 0;
      await new MemoryOrchestrator({
        memoryManager: new MemoryManager(storage),
        callLLM: async (system) => {
          if (!system.includes("write decision")) return JSON.stringify([first, opposite]);
          decisions++;
          return "malformed";
        },
      }).run([{ role: "user", content: "Remember both distinct policies" }], "batch-fallback");

      expect(decisions).toBe(1);
      expect(
        new MemoryManager({ ...storage, scope: "dream" })
          .loadAll()
          .map((memory) => memory.content)
          .sort(),
      ).toEqual([first.content, opposite.content].sort());
    });
  });
});

describe("MemoryOrchestrator bounded old-body comparisons", () => {
  it("limits each and all old-body excerpts, labels missing text and redacts before clipping", async () => {
    await withStorage(async (storage) => {
      const dream = new MemoryManager({ ...storage, scope: "dream" });
      const token = "sk-proj-ABCDEF1234567890ABCDEF1234567890";
      for (let index = 0; index < 12; index++) {
        dream.save({
          ...first,
          id: `old-${index}`,
          name: `${first.name}-${index}`,
          description: `Project package manager policy ${index}`,
          content:
            "Do not use npm on port 4000; use Bun on port 3000.\n" +
            "x".repeat(1_400) +
            `\nAuthorization: Bearer ${token}\n` +
            "x".repeat(3_000),
          updatedAt: `2026-01-${String(12 - index).padStart(2, "0")}T00:00:00.000Z`,
          origin: "auto",
        });
      }
      let comparisons: ComparedMemory[] = [];
      await new MemoryOrchestrator({
        memoryManager: new MemoryManager(storage),
        callLLM: async (system, prompt) => {
          if (!system.includes("write decision")) return JSON.stringify([first]);
          comparisons = comparedMemories(prompt);
          expect(prompt).not.toContain(token);
          expect(prompt).not.toContain("sk-proj-ABC");
          expect(prompt).toContain("Missing text is not evidence");
          expect(prompt).toContain("direction, negation, numbers and scope");
          return JSON.stringify({ action: "ADD" });
        },
      }).run([{ role: "user", content: "Remember the policy" }], "body-budget");

      expect(comparisons).toHaveLength(12);
      expect(comparisons[0]!.bodyExcerpt.text).toContain("Do not use npm on port 4000");
      expect(comparisons[0]!.bodyExcerpt.text).toContain("[redacted]");
      expect(comparisons.every((memory) => memory.bodyExcerpt.text.length <= 1_500)).toBe(true);
      expect(comparisons.reduce((sum, memory) => sum + memory.bodyExcerpt.text.length, 0)).toBe(
        8_000,
      );
      expect(comparisons.some((memory) => memory.bodyExcerpt.status === "truncated")).toBe(true);
      expect(comparisons.some((memory) => memory.bodyExcerpt.status === "omitted")).toBe(true);
      expect(new MemoryManager({ ...storage, scope: "dream" }).loadAll()).toHaveLength(13);
    });
  });

  for (const action of ["UPDATE", "DELETE"]) {
    it(`never lets ${action} target a memory whose body the model was not shown`, async () => {
      await withStorage(async (storage) => {
        const dream = new MemoryManager({ ...storage, scope: "dream" });
        for (let index = 0; index < 12; index++) {
          dream.save({
            ...first,
            id: `old-${index}`,
            name: `${first.name}-${index}`,
            description: `Project package manager policy ${index}`,
            content: `Policy ${index}. ${"x".repeat(1_400)}`,
            origin: "auto",
          });
        }
        for (let index = 0; index < 33; index++) {
          dream.save({
            ...first,
            id: `unrelated-${index}`,
            name: `release-note-${index}`,
            description: `Release note archive ${index}`,
            content: `Unrelated note ${index}.`,
            origin: "auto",
          });
        }
        const targets: string[] = [];
        await new MemoryOrchestrator({
          memoryManager: new MemoryManager(storage),
          callLLM: async (system, prompt) => {
            if (!system.includes("write decision")) {
              return JSON.stringify([first, { ...first, content: "Use Bun for every project." }]);
            }
            const compared = comparedMemories(prompt);
            const catalogue = prompt
              .split("Existing memories catalogue (JSON lines):\n")[1]!
              .split("\nCandidate:\n")[0]!
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { id: string });
            // First decision: a related memory whose body was left out by the
            // budget. Second: a catalogue entry outside the related list.
            const target =
              targets.length === 0
                ? compared.find((memory) => memory.bodyExcerpt.status === "omitted")!
                : catalogue.find((memory) => !compared.some((c) => c.id === memory.id))!;
            expect(target).toBeDefined();
            targets.push(target.id);
            return JSON.stringify({ action, target: { ...target, scope: "dream" } });
          },
        }).run([{ role: "user", content: "Remember the policy" }], `unseen-${action}`);

        expect(targets).toHaveLength(2);
        for (const id of targets) {
          expect(dream.findById(id)).toMatchObject({ updateCount: 0 });
          expect(dream.findById(id)!.content).not.toContain("Use Bun");
        }
      });
    });

    it(`protects manual memory when the model requests ${action} after seeing its body`, async () => {
      await withStorage(async (storage) => {
        const user = new MemoryManager(storage);
        user.save({ ...first, id: "manual-policy", origin: "manual" });
        await new MemoryOrchestrator({
          memoryManager: user,
          callLLM: async (system, prompt) => {
            if (!system.includes("write decision")) return JSON.stringify([updated]);
            const previous = comparedMemories(prompt)[0]!;
            expect(previous).toMatchObject({
              id: "manual-policy",
              origin: "manual",
              bodyExcerpt: { text: first.content, status: "complete" },
            });
            return JSON.stringify({ action, target: previous });
          },
        }).run([{ role: "user", content: "Remember the policy" }], "manual-body");

        expect(user.findById("manual-policy")!).toMatchObject({
          content: first.content,
          origin: "manual",
          updateCount: 0,
        });
        expect(new MemoryManager({ ...storage, scope: "dream" }).loadAll()).toHaveLength(0);
      });
    });
  }
});
