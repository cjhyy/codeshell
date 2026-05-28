import { describe, expect, test } from "bun:test";
import { parsePaths } from "../../packages/tui/src/cli/commands/builtin/image-command.js";

describe("parsePaths", () => {
  test("splits on whitespace", () => {
    expect(parsePaths("foo.png bar.jpg baz.gif")).toEqual([
      "foo.png",
      "bar.jpg",
      "baz.gif",
    ]);
  });

  test("returns empty for empty/whitespace arg", () => {
    expect(parsePaths("")).toEqual([]);
    expect(parsePaths("   ")).toEqual([]);
  });

  test("accepts a single path", () => {
    expect(parsePaths("just-one.png")).toEqual(["just-one.png"]);
  });

  test("preserves spaces inside double quotes", () => {
    expect(parsePaths(`"name with spaces.png"`)).toEqual(["name with spaces.png"]);
  });

  test("mixes quoted and unquoted", () => {
    expect(
      parsePaths(`a.png "b c.jpg" /tmp/d.gif`),
    ).toEqual(["a.png", "b c.jpg", "/tmp/d.gif"]);
  });

  test("tolerates extra whitespace between args", () => {
    expect(parsePaths(`  a.png   b.jpg  `)).toEqual(["a.png", "b.jpg"]);
  });
});
