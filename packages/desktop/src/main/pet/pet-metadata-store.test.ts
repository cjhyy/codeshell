import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetMetadataStore } from "./pet-metadata-store";

describe("PetMetadataStore", () => {
  test("atomically creates and then reuses one local pet session", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-metadata-"));
    try {
      const filePath = join(root, "pet", "metadata.json");
      const store = new PetMetadataStore(filePath, {
        now: () => 123,
        createSessionId: () => "pet-stable",
      });
      const first = await store.ensure();
      const second = await store.ensure();

      expect(first).toEqual({
        version: 1,
        owner: "local-user",
        petId: "local-pet",
        petSessionId: "pet-stable",
        createdAt: 123,
      });
      expect(second).toEqual(first);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rebuilds corrupt metadata without deleting unrelated work data", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-corrupt-"));
    try {
      const dir = join(root, "pet");
      const filePath = join(dir, "metadata.json");
      const workFile = join(root, "work-session.json");
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, "not json", "utf8");
      await writeFile(workFile, "keep", "utf8");
      const store = new PetMetadataStore(filePath, {
        now: () => 456,
        createSessionId: () => "pet-rebuilt",
      });

      expect((await store.ensure()).petSessionId).toBe("pet-rebuilt");
      expect(await readFile(workFile, "utf8")).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
