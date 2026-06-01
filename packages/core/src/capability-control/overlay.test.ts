import { describe, test, expect } from "bun:test";
import {
  applyOverride,
  bucketForKind,
  overrideTokenForId,
  overrideFor,
  effectiveDisabledList,
} from "./overlay.js";

describe("applyOverride matrix (spec §12.2)", () => {
  const cases: Array<[boolean, "inherit" | "on" | "off" | undefined, boolean]> = [
    [true, undefined, true],
    [true, "inherit", true],
    [true, "off", false],
    [true, "on", true],
    [false, undefined, false],
    [false, "inherit", false],
    [false, "off", false],
    [false, "on", true],
  ];
  for (const [global, override, expected] of cases) {
    test(`global=${global} override=${override} -> ${expected}`, () => {
      expect(applyOverride(global, override)).toBe(expected);
    });
  }
  test("unknown override value treated as inherit", () => {
    expect(applyOverride(true, "bogus" as any)).toBe(true);
    expect(applyOverride(false, "bogus" as any)).toBe(false);
  });
});

describe("bucketForKind", () => {
  test("maps descriptor kinds to override buckets", () => {
    expect(bucketForKind("skill")).toBe("skills");
    expect(bucketForKind("plugin")).toBe("plugins");
    expect(bucketForKind("mcp")).toBe("mcp");
    expect(bucketForKind("agent")).toBe("agents");
  });
  test("builtin has no bucket", () => {
    expect(bucketForKind("builtin")).toBeUndefined();
  });
});

describe("overrideTokenForId", () => {
  test("strips the kind prefix only (keeps the rest, incl. nested colons)", () => {
    expect(overrideTokenForId("skill:superpowers:brainstorming")).toBe(
      "superpowers:brainstorming",
    );
    expect(overrideTokenForId("mcp:playwright")).toBe("playwright");
  });
  test("returns the id unchanged when there is no prefix", () => {
    expect(overrideTokenForId("bareword")).toBe("bareword");
  });
});

describe("overrideFor", () => {
  test("returns on/off for the right bucket+token", () => {
    const overrides = { skills: { a: "off" as const }, mcp: { gh: "on" as const } };
    expect(overrideFor(overrides, "skill", "a")).toBe("off");
    expect(overrideFor(overrides, "mcp", "gh")).toBe("on");
  });
  test("normalizes inherit / missing / garbage to undefined", () => {
    const overrides = { skills: { a: "inherit" as const } };
    expect(overrideFor(overrides, "skill", "a")).toBeUndefined();
    expect(overrideFor(overrides, "skill", "missing")).toBeUndefined();
    expect(overrideFor(undefined, "skill", "a")).toBeUndefined();
    expect(overrideFor(overrides, "builtin", "a")).toBeUndefined();
  });
});

describe("effectiveDisabledList", () => {
  test("project 'on' removes from disabled; project 'off' adds", () => {
    const out = effectiveDisabledList(["a", "b"], { a: "on", c: "off" });
    expect(new Set(out)).toEqual(new Set(["b", "c"]));
  });
  test("undefined overrides returns the baseline unchanged", () => {
    expect(effectiveDisabledList(["a"], undefined)).toEqual(["a"]);
  });
  test("inherit leaves the baseline alone", () => {
    expect(effectiveDisabledList(["a"], { a: "inherit", b: "inherit" })).toEqual(["a"]);
  });
});
