import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryOrchestrator } from "./memory-orchestrator.js";
import { MemoryManager } from "../session/memory.js";
import { logger } from "../logging/logger.js";
import type { ExtractedMemory } from "./extract-memories.js";

type Fact = Pick<ExtractedMemory, "name" | "description" | "content">;
const fixtures: Array<[string, Fact, Fact]> = [
  [
    "opposite preference directions",
    { name: "package-manager", description: "Use bun not npm", content: "Use bun not npm." },
    { name: "package-manager", description: "Use npm not bun", content: "Use npm not bun." },
  ],
  [
    "different component policies",
    {
      name: "frontend-package-manager",
      description: "Use bun not npm",
      content: "The frontend uses bun, not npm.",
    },
    {
      name: "backend-package-manager",
      description: "Use npm not bun",
      content: "The backend uses npm, not bun.",
    },
  ],
  [
    "parallel runtime versions",
    {
      name: "node-18-runtime",
      description: "Node 18 support requirements",
      content: "Node 18 needs a legacy addon.",
    },
    {
      name: "node-22-runtime",
      description: "Node 22 support requirements",
      content: "Node 22 needs a modern addon.",
    },
  ],
  [
    "independent port bindings",
    {
      name: "localhost-port-3000",
      description: "Local service on port 3000",
      content: "Port 3000 serves the frontend.",
    },
    {
      name: "localhost-port-4000",
      description: "Local service on port 4000",
      content: "Port 4000 serves the backend.",
    },
  ],
  [
    "identical summaries with distinct bodies",
    {
      name: "service-address",
      description: "Internal service address",
      content: "Production uses localhost:3000.",
    },
    {
      name: "service-address",
      description: "Internal service address",
      content: "Staging uses localhost:4000.",
    },
  ],
];

async function runPair(
  old: Fact,
  next: Fact,
  action: "ADD" | "invalid",
  seed: { type?: ExtractedMemory["type"]; location?: "project" | "global" } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cs-memory-canonical-"));
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const projectDir = join(root, "workspace");
    const store = new MemoryManager({ baseDir: root, projectDir, scope: "dream" });
    const seedStore =
      seed.location === "global" ? new MemoryManager({ baseDir: root, scope: "dream" }) : store;
    seedStore.save({ ...old, type: seed.type ?? "project", origin: "auto" });
    const original = seedStore.loadAll()[0]!;
    await new MemoryOrchestrator({
      memoryManager: new MemoryManager({ baseDir: root, projectDir }),
      callLLM: async (system) =>
        system.includes("write decision")
          ? action === "invalid"
            ? "malformed"
            : JSON.stringify({ action })
          : JSON.stringify([{ ...next, type: "project", scope: "project" }]),
    }).run([{ role: "user", content: next.content }], "isolated-fixture");
    const stats = info.mock.calls.find((call) => call[0] === "memory.extraction_done")?.[1] as
      | { addCount: number; updateCount: number; noopCount: number }
      | undefined;
    return { original, entries: store.loadAll(), seeded: seedStore.loadAll(), stats };
  } finally {
    info.mockRestore();
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [title, old, next] of fixtures) {
  for (const action of ["ADD", "invalid"] as const) {
    test(`${title}: ${action} never overwrites the old automatic memory`, async () => {
      const { original, entries, stats } = await runPair(old, next, action);
      expect(entries.find((entry) => entry.id === original.id)?.content).toBe(old.content);
      expect(entries).toHaveLength(2);
      expect(
        entries.some((entry) => entry.id !== original.id && entry.content === next.content),
      ).toBe(true);
      expect(stats).toMatchObject({ addCount: 1, updateCount: 0, noopCount: 0 });
    });
  }
}

for (const action of ["ADD", "invalid"] as const) {
  test(`an exact duplicate with ${action} is a NOOP without a memory rewrite`, async () => {
    const fact = {
      name: "runtime-choice",
      description: "Bun tooling",
      content: "Use Bun for tooling.",
    };
    const { original, entries, stats } = await runPair(fact, fact, action);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(original.id);
    expect(entries[0]!.updatedAt).toBe(original.updatedAt);
    expect(entries[0]!.updateCount).toBe(0);
    expect(stats).toMatchObject({ addCount: 0, updateCount: 0, noopCount: 1 });
  });
}

test("an exact duplicate still deduplicates when its title has no recall tokens", async () => {
  const fact = { name: "18", description: "22", content: "Numeric identifiers are significant." };
  const { entries, stats } = await runPair(fact, fact, "invalid");
  expect(entries).toHaveLength(1);
  expect(stats).toMatchObject({ addCount: 0, updateCount: 0, noopCount: 1 });
});

test("identical text in a different memory type is not an exact duplicate", async () => {
  const fact = {
    name: "runtime-choice",
    description: "Bun tooling",
    content: "Use Bun for tooling.",
  };
  const { entries } = await runPair(fact, fact, "ADD", { type: "reference" });
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.type).sort()).toEqual(["project", "reference"]);
});

test("identical global text does not suppress a project-scoped memory", async () => {
  const fact = {
    name: "runtime-choice",
    description: "Bun tooling",
    content: "Use Bun for tooling.",
  };
  const { original, entries, seeded } = await runPair(fact, fact, "ADD", { location: "global" });
  expect(seeded).toHaveLength(1);
  expect(seeded[0]!.id).toBe(original.id);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.id).not.toBe(original.id);
});
