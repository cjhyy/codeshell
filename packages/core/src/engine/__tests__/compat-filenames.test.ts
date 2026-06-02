import { describe, it, expect } from "bun:test";
import { compatFileNamesFrom } from "../engine.js";

describe("compatFileNamesFrom", () => {
  it("defaults to both when undefined (backward compatible)", () => {
    expect(compatFileNamesFrom(undefined)).toEqual(["CLAUDE.md", "AGENTS.md"]);
  });
  it("drops CLAUDE.md when compatClaude is false", () => {
    expect(compatFileNamesFrom({ compatClaude: false, compatCodex: true })).toEqual(["AGENTS.md"]);
  });
  it("drops AGENTS.md when compatCodex is false", () => {
    expect(compatFileNamesFrom({ compatClaude: true, compatCodex: false })).toEqual(["CLAUDE.md"]);
  });
  it("drops both when both false", () => {
    expect(compatFileNamesFrom({ compatClaude: false, compatCodex: false })).toEqual([]);
  });
});
