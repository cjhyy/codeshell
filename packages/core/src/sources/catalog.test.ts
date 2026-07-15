import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteSourceDefinition,
  listSourceDefinitions,
  readSourceDefinition,
  saveSourceDefinition,
} from "./catalog.js";

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

  test("missing/unparseable file → empty list", () => {
    expect(listSourceDefinitions()).toEqual([]);
    writeFileSync(join(home, "sources.json"), "not json");
    expect(listSourceDefinitions()).toEqual([]);
  });
});
