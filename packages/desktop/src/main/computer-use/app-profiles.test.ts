import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppProfileIndex,
  describedApp,
  loadAppProfiles,
  MAX_APP_NOTES,
  parseAppProfile,
  withAppNotes,
} from "./app-profiles";

const BUNDLED = join(import.meta.dir, "../../../resources/computer-use/apps");
const profile = (front: string, body = "Use set_value.") => `---\n${front}\n---\n${body}\n`;

describe("app profiles", () => {
  test("every bundled profile parses", () => {
    const errors: string[] = [];
    const index = loadAppProfiles(BUNDLED, (file, error) => errors.push(`${file}: ${error}`));
    expect(errors).toEqual([]);
    expect(index.profiles.map((item) => item.id)).toEqual(["chrome", "slack", "video-calls"]);
    expect(index.byId("video-calls")?.stage.quiet).toBe(true);
    expect(index.byId("chrome")?.stage).toEqual({
      perch: "title-bar",
      keepClear: ["text"],
      quiet: false,
    });
  });

  test("parses the strict frontmatter subset", () => {
    const parsed = parseAppProfile(
      profile(
        'id: notes\nbundleIds: [com.example.Notes]\nnames: ["Notes", Notes Beta]\nstage:\n  perch: screen-corner\n  keepClear: [text, button]\n  quiet: false',
      ),
      "notes",
    );
    expect(parsed).toEqual({
      id: "notes",
      bundleIds: ["com.example.Notes"],
      names: ["Notes", "Notes Beta"],
      notes: "Use set_value.",
      stage: { perch: "screen-corner", keepClear: ["text", "button"], quiet: false },
    });
  });

  test("rejects profiles that do not identify an app or exceed their bounds", () => {
    const bad: Array<[string, string]> = [
      ["id: other\nnames: [X]", "mismatch"],
      ["id: x\n", "no app"],
      ["id: x\nbundleIds: [bad id!]", "bundle"],
      ["id: x\nnames: [X]\nstage:\n  perch: ceiling", "perch"],
      ["id: x\nnames: [X]\nstage:\n  keepClear: [password]", "kind"],
      ["id: x\nnames: [X]\nstage:\n  quiet: sometimes", "quiet"],
      ["id: x\nnames: [X]\n  stray indented line", "line"],
    ];
    for (const [front] of bad) expect(() => parseAppProfile(profile(front), "x")).toThrow();
    expect(() => parseAppProfile("no frontmatter", "x")).toThrow();
    expect(() => parseAppProfile(profile("id: x\nnames: [X]", ""), "x")).toThrow();
    expect(() =>
      parseAppProfile(profile("id: x\nnames: [X]", "a".repeat(MAX_APP_NOTES + 1)), "x"),
    ).toThrow();
  });

  test("a broken file is skipped without hiding the others", () => {
    const directory = mkdtempSync(join(tmpdir(), "app-profiles-"));
    try {
      writeFileSync(join(directory, "good.md"), profile("id: good\nnames: [Good]"));
      writeFileSync(join(directory, "broken.md"), profile("id: wrong\nnames: [Broken]"));
      writeFileSync(join(directory, "readme.txt"), "ignored");
      const skipped: string[] = [];
      const index = loadAppProfiles(directory, (file) => skipped.push(file));
      expect(skipped).toEqual(["broken.md"]);
      expect(index.profiles.map((item) => item.id)).toEqual(["good"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(loadAppProfiles(undefined).profiles).toEqual([]);
    expect(loadAppProfiles("/nonexistent/apps").profiles).toEqual([]);
  });

  test("bundle id wins over app name, and names match case-insensitively", () => {
    const index = new AppProfileIndex([
      parseAppProfile(profile("id: a\nbundleIds: [com.a]\nnames: [Shared]"), "a"),
      parseAppProfile(profile("id: b\nbundleIds: [com.b]\nnames: [Other]"), "b"),
    ]);
    expect(index.match({ bundleId: "com.b", name: "Shared" })?.id).toBe("b");
    expect(index.match({ name: "shared" })?.id).toBe("a");
    expect(index.match({ bundleId: "com.unknown", name: "Unknown" })).toBeUndefined();
  });

  test("notes append to successful results only, as a separate text part", () => {
    const item = parseAppProfile(profile("id: s\nnames: [Slack]"), "s");
    const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "tree" }] } };
    const noted = withAppNotes(ok, item) as any;
    expect(noted.result.content).toHaveLength(2);
    expect(noted.result.content[1].text).toBe("CodeShell app notes for Slack:\nUse set_value.");
    expect(ok.result.content).toHaveLength(1);
    expect(withAppNotes({ id: 1, result: { isError: true, content: [] } }, item)).toBeUndefined();
    expect(withAppNotes({ id: 1, error: { message: "x" } }, item)).toBeUndefined();
  });

  test("an app is described only by its pid, bundle id and name", () => {
    expect(
      describedApp({ structuredContent: { pid: 9, app_name: "Slack", window_title: "secret" } }),
    ).toEqual({ pid: 9, bundleId: undefined, name: "Slack" });
    expect(describedApp({ structuredContent: { bundle_id: "com.a", name: "A", pid: -1 } })).toEqual(
      {
        pid: undefined,
        bundleId: "com.a",
        name: "A",
      },
    );
    expect(describedApp({ structuredContent: {} })).toBeUndefined();
    expect(describedApp(undefined)).toBeUndefined();
  });
});
