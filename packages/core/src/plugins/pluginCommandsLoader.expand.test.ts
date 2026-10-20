import { describe, expect, test } from "bun:test";
import {
  expandPluginCommandBody,
  MAX_PLUGIN_COMMAND_ARGUMENT_CHARS,
  MAX_PLUGIN_COMMAND_EXPANDED_CHARS,
} from "./pluginCommandsLoader.js";

describe("expandPluginCommandBody", () => {
  test("expands CodeShell/CC all-argument placeholders", () => {
    expect(expandPluginCommandBody("A=$ARGUMENTS B={args}", "one two")).toBe("A=one two B=one two");
  });

  test("expands Codex positional and quoted named placeholders", () => {
    expect(
      expandPluginCommandBody(
        "first=$1 second=$2 file=$FILE focus=$FOCUS",
        'alpha "two words" FILE=src/a.ts FOCUS="loading state"',
      ),
    ).toBe("first=alpha second=two words file=src/a.ts focus=loading state");
  });

  test("keeps unknown environment-like placeholders and restores literal dollars", () => {
    expect(
      expandPluginCommandBody("root=$PLUGIN_ROOT price=$$10 ticket=$TICKET_ID", "TICKET_ID=CS-42"),
    ).toBe("root=$PLUGIN_ROOT price=$10 ticket=CS-42");
  });

  test("substitutes the template once without re-expanding placeholders from user arguments", () => {
    const value = "y".repeat(16_000);
    const references = "$VALUE".repeat(2_000);
    const rawArguments = `VALUE=${value} ${references}`;

    expect(rawArguments.length).toBeLessThan(MAX_PLUGIN_COMMAND_ARGUMENT_CHARS);
    expect(expandPluginCommandBody("raw=$ARGUMENTS named=$VALUE", rawArguments)).toBe(
      `raw=${rawArguments} named=${value}`,
    );
  });

  // Regression (PLUGIN-R8-01): an explicitly empty quoted argument is still a
  // positional argument; dropping it shifted every later position left.
  test("keeps empty quoted arguments in their positions", () => {
    expect(expandPluginCommandBody("one=<$1> two=<$2> three=<$3>", '"" next last')).toBe(
      "one=<> two=<next> three=<last>",
    );
    expect(expandPluginCommandBody("<$1>|<$2>|<$3>", "left '' right")).toBe("<left>|<>|<right>");
    expect(expandPluginCommandBody("<$1>|<$2>", "a   b")).toBe("<a>|<b>");
  });

  test("removes missing positional placeholders", () => {
    expect(expandPluginCommandBody("$1/$2/$9", "only")).toBe("only//");
  });

  test("bounds raw arguments and placeholder amplification", () => {
    expect(() =>
      expandPluginCommandBody("prompt", "x".repeat(MAX_PLUGIN_COMMAND_ARGUMENT_CHARS + 1)),
    ).toThrow(/arguments exceed/);
    const repeated = Array.from(
      { length: Math.ceil(MAX_PLUGIN_COMMAND_EXPANDED_CHARS / 100) },
      () => "$ARGUMENTS",
    ).join("");
    expect(() => expandPluginCommandBody(repeated, "x".repeat(100))).toThrow(
      /expanded plugin command exceeds/,
    );
  });
});
