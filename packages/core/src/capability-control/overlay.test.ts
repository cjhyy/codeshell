import { describe, test, expect } from "bun:test";
import {
  applyOverride,
  bucketForKind,
  overrideTokenForId,
  overrideFor,
  effectiveDisabledList,
  effectiveBuiltinLists,
  whitelistDisabledList,
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
    expect(bucketForKind("builtin")).toBe("builtin");
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
  test("reads the builtin bucket too (now a first-class override)", () => {
    const overrides = { builtin: { REPL: "off" as const } };
    expect(overrideFor(overrides, "builtin", "REPL")).toBe("off");
  });
  test("normalizes inherit / missing / garbage to undefined", () => {
    const overrides = { skills: { a: "inherit" as const } };
    expect(overrideFor(overrides, "skill", "a")).toBeUndefined();
    expect(overrideFor(overrides, "skill", "missing")).toBeUndefined();
    expect(overrideFor(undefined, "skill", "a")).toBeUndefined();
    expect(overrideFor(overrides, "builtin", "missing")).toBeUndefined();
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

describe("whitelistDisabledList (no-repo opt-in inversion)", () => {
  test("empty bucket → everything disabled (default-all-off)", () => {
    expect(whitelistDisabledList(["a", "b", "c"], undefined)).toEqual(["a", "b", "c"]);
    expect(whitelistDisabledList(["a", "b"], {})).toEqual(["a", "b"]);
  });
  test("{a:'on'} → all but a disabled (whitelist)", () => {
    expect(new Set(whitelistDisabledList(["a", "b", "c"], { a: "on" }))).toEqual(
      new Set(["b", "c"]),
    );
  });
  test("{a:'off'} → a is also disabled (off still counts as off)", () => {
    expect(new Set(whitelistDisabledList(["a", "b"], { a: "off" }))).toEqual(
      new Set(["a", "b"]),
    );
  });
  test("inherit / garbage values stay disabled (only explicit 'on' allows)", () => {
    expect(new Set(whitelistDisabledList(["a", "b"], { a: "inherit" as any, b: "junk" as any }))).toEqual(
      new Set(["a", "b"]),
    );
  });
  test("an 'on' for a name not installed is harmless (no phantom entry)", () => {
    expect(whitelistDisabledList(["a"], { ghost: "on" })).toEqual(["a"]);
  });
  test("collapses duplicate installed names", () => {
    expect(whitelistDisabledList(["a", "a", "b"], { a: "on" })).toEqual(["b"]);
  });
  test("empty install set → empty disabled list", () => {
    expect(whitelistDisabledList([], { a: "on" })).toEqual([]);
  });
});

describe("effectiveBuiltinLists", () => {
  test("'on' force-enables: add to enabled, drop from disabled", () => {
    const out = effectiveBuiltinLists([], ["REPL"], { REPL: "on" });
    expect(new Set(out.enabledBuiltinTools)).toEqual(new Set(["REPL"]));
    expect(out.disabledBuiltinTools).toEqual([]);
  });
  test("'off' force-disables: add to disabled, drop from enabled", () => {
    const out = effectiveBuiltinLists(["Bash"], [], { Bash: "off" });
    expect(out.enabledBuiltinTools).toEqual([]);
    expect(new Set(out.disabledBuiltinTools)).toEqual(new Set(["Bash"]));
  });
  test("inherit / undefined leaves both baselines unchanged", () => {
    const a = effectiveBuiltinLists(["x"], ["y"], { z: "inherit" });
    expect(new Set(a.enabledBuiltinTools)).toEqual(new Set(["x"]));
    expect(new Set(a.disabledBuiltinTools)).toEqual(new Set(["y"]));
    const b = effectiveBuiltinLists(["x"], ["y"], undefined);
    expect(b.enabledBuiltinTools).toEqual(["x"]);
    expect(b.disabledBuiltinTools).toEqual(["y"]);
  });
});
