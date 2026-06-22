import { describe, test, expect } from "bun:test";
import { pruneDisabledEntriesForPlugin } from "./pruneDisabled.js";

describe("pruneDisabledEntriesForPlugin", () => {
  test("removes the plugin's bare name and its name:skill entries", () => {
    const out = pruneDisabledEntriesForPlugin(
      {
        disabledSkills: ["mimi-video:director-skill", "other:s"],
        disabledPlugins: ["mimi-video", "x"],
      },
      "mimi-video",
    );
    expect(out.disabledSkills).toEqual(["other:s"]);
    expect(out.disabledPlugins).toEqual(["x"]);
  });

  test("does not crash and returns settings unchanged when fields are absent", () => {
    const input = { other: 1 } as Record<string, unknown>;
    const out = pruneDisabledEntriesForPlugin(input, "mimi-video");
    expect(out).toEqual({ other: 1 });
  });

  test("is immutable — does not mutate the input arrays", () => {
    const input = {
      disabledSkills: ["mimi-video:s"],
      disabledPlugins: ["mimi-video"],
    };
    const out = pruneDisabledEntriesForPlugin(input, "mimi-video");
    expect(input.disabledSkills).toEqual(["mimi-video:s"]);
    expect(input.disabledPlugins).toEqual(["mimi-video"]);
    expect(out).not.toBe(input);
  });

  test("does not remove a plugin whose name is a prefix of another", () => {
    const out = pruneDisabledEntriesForPlugin(
      {
        disabledSkills: ["mimi-video-pro:s", "mimi-video:s"],
        disabledPlugins: ["mimi-video-pro", "mimi-video"],
      },
      "mimi-video",
    );
    expect(out.disabledSkills).toEqual(["mimi-video-pro:s"]);
    expect(out.disabledPlugins).toEqual(["mimi-video-pro"]);
  });
});
