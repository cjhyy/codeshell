import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteSourceDefinition,
  listSourceDefinitions,
  readSourceDefinition,
  saveSourceDefinition,
} from "./catalog.js";

const CATALOG_MODULE = join(import.meta.dir, "catalog.ts");

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-src-cat-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("source catalog store", () => {
  test("save/read/list/delete round-trip, sorted by id", () => {
    saveSourceDefinition({
      id: "b",
      kind: "mock",
      label: "B",
      adapterConfig: {},
      enabled: true,
    });
    saveSourceDefinition({
      id: "a",
      kind: "mock",
      label: "A",
      adapterConfig: {},
      enabled: true,
    });
    expect(listSourceDefinitions().map((s) => s.id)).toEqual(["a", "b"]);
    expect(readSourceDefinition("a")?.label).toBe("A");
    saveSourceDefinition({
      id: "a",
      kind: "mock",
      label: "A2",
      adapterConfig: {},
      enabled: false,
    });
    expect(readSourceDefinition("a")?.label).toBe("A2");
    deleteSourceDefinition("a");
    expect(readSourceDefinition("a")).toBeUndefined();
  });

  test("corrupted entries are isolated, valid ones survive", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "sources.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "ok", kind: "mock", label: "OK" }, { id: "BAD ID" }],
      }),
    );
    expect(listSourceDefinitions().map((s) => s.id)).toEqual(["ok"]);
  });

  test("deduplicates forged catalog ids and keeps the last bounded entry", () => {
    writeFileSync(
      join(home, "sources.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { id: "same", kind: "mock", label: "Before" },
          { id: "same", kind: "mock", label: "After" },
        ],
      }),
    );
    expect(listSourceDefinitions()).toEqual([
      expect.objectContaining({ id: "same", label: "After" }),
    ]);
  });

  test("rejects unbounded definition fields and unsafe delete ids", () => {
    expect(() =>
      saveSourceDefinition({
        id: "big",
        kind: "mock",
        label: "x".repeat(513),
        adapterConfig: {},
        enabled: true,
      }),
    ).toThrow();
    expect(() => deleteSourceDefinition("../outside")).toThrow();
    expect(listSourceDefinitions()).toEqual([]);
  });

  test("oversized and symlinked catalog files fail closed", () => {
    const file = join(home, "sources.json");
    writeFileSync(file, "x".repeat(4 * 1024 * 1024 + 1));
    expect(listSourceDefinitions()).toEqual([]);
    if (process.platform !== "win32") {
      const outside = join(home, "outside.json");
      writeFileSync(
        outside,
        JSON.stringify({ version: 1, sources: [{ id: "secret", kind: "mock", label: "S" }] }),
      );
      rmSync(file, { force: true });
      symlinkSync(outside, file);
      expect(listSourceDefinitions()).toEqual([]);
    }
  });

  test("missing/unparseable file → empty list", () => {
    expect(listSourceDefinitions()).toEqual([]);
    writeFileSync(join(home, "sources.json"), "not json");
    expect(listSourceDefinitions()).toEqual([]);
  });

  test("writes the catalog owner-only without dangling temporary files", () => {
    saveSourceDefinition({ id: "private", kind: "mock", label: "Private", adapterConfig: {} });
    const file = join(home, "sources.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test(
    "concurrent processes preserve every independently saved source",
    async () => {
      const total = 24;
      const processes = Array.from({ length: total }, (_, index) => {
        const script = `
          import { saveSourceDefinition } from ${JSON.stringify(CATALOG_MODULE)};
          saveSourceDefinition({
            id: ${JSON.stringify(`source-${index}`)},
            kind: "mock",
            label: ${JSON.stringify(`Source ${index}`)},
            adapterConfig: {},
            enabled: true,
          });
        `;
        return Bun.spawn([process.execPath, "-e", script], {
          env: { ...process.env, CODE_SHELL_HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        });
      });
      expect((await Promise.all(processes.map((process) => process.exited))).every((code) => code === 0)).toBe(
        true,
      );
      expect(listSourceDefinitions().map((source) => source.id)).toEqual(
        Array.from({ length: total }, (_, index) => `source-${index}`).sort(),
      );
    },
    60_000,
  );
});
