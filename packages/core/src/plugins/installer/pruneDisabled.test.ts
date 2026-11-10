import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock } from "../../utils/file-mutex.js";
import { pruneDisabledEntriesForPlugin, pruneDisabledSettingsForPlugin } from "./pruneDisabled.js";

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

describe("pruneDisabledSettingsForPlugin", () => {
  let home: string;
  let previousHome: string | undefined;
  let path: string;
  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-prune-settings-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".code-shell"));
    path = join(home, ".code-shell", "settings.json");
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("preserves unrelated settings and writes owner-only permissions", () => {
    const current = {
      disabledPlugins: ["mimi-video", "keep"],
      disabledSkills: ["mimi-video:s", "keep:s"],
      defaults: { text: "connection" },
      extensionData: { keep: [1, 2, 3] },
    };
    writeFileSync(path, JSON.stringify(current));
    chmodSync(path, 0o644);

    pruneDisabledSettingsForPlugin("mimi-video");

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      ...current,
      disabledPlugins: ["keep"],
      disabledSkills: ["keep:s"],
    });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("does not create a missing settings file", () => {
    pruneDisabledSettingsForPlugin("mimi-video");
    expect(existsSync(path)).toBe(false);
  });

  test.each(["{ broken", "null", "[]", "42", '{ "disabledPlugins": ["keep"] }\n'])(
    "leaves invalid or unchanged settings byte-for-byte intact: %s",
    (original) => {
      writeFileSync(path, original);
      pruneDisabledSettingsForPlugin("mimi-video");
      expect(readFileSync(path, "utf-8")).toBe(original);
    },
  );

  test("waits for a competing settings writer and reads its committed update", async () => {
    writeFileSync(path, JSON.stringify({ disabledPlugins: ["mimi-video"] }));
    const release = acquireFileLock(path);
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { pruneDisabledSettingsForPlugin } from ${JSON.stringify(join(import.meta.dir, "pruneDisabled.ts"))};
         process.stdout.write("ready\\n");
         pruneDisabledSettingsForPlugin("mimi-video");`,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home } },
    );
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
      const state = await Promise.race([
        child.exited.then(() => "exited"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]);
      expect(state).toBe("waiting");
      writeFileSync(
        path,
        JSON.stringify({ disabledPlugins: ["mimi-video", "keep"], extensionData: "new value" }),
      );
    } finally {
      release();
      await child.exited;
    }
    expect(child.exitCode).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      disabledPlugins: ["keep"],
      extensionData: "new value",
    });
  });
});
