import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPluginFromPath } from "../packages/core/src/plugins/installer/install.js";
import {
  CODESHELL_PLUGIN_OVERLAY_FILE,
  CodeShellPluginOverlay,
  CodexPluginManifest,
} from "../packages/core/src/plugins/installer/types.js";
import {
  loadPluginAutomationTemplateContributions,
  loadPluginCatalog,
  loadPluginPanelContributions,
} from "../packages/core/src/plugins/pluginCatalog.js";
import { describePluginContent } from "../packages/core/src/plugins/pluginContent.js";
import {
  expandPluginCommandBody,
  invalidatePluginCommandsCache,
  scanPluginCommands,
} from "../packages/core/src/plugins/pluginCommandsLoader.js";
import { invalidateSkillCache, scanSkills } from "../packages/core/src/skills/scanner.js";
import {
  buildAtempoFilter,
  buildFrameCommands,
  buildRenderCommand,
  normalizePlan,
  parseFrameTimes,
  parseTimecode,
  validateRenderedOutput,
} from "../examples/plugins/video-editor/skills/video-editor/scripts/video-editor.mjs";

const ROOT = join(import.meta.dir, "..", "examples", "plugins", "video-editor");

describe("video-editor example plugin", () => {
  test("manifest is accepted by the CodeShell Codex compatibility schema", () => {
    const rawManifest = JSON.parse(
      readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf-8"),
    );
    const manifest = CodexPluginManifest.parse(rawManifest);
    const overlay = CodeShellPluginOverlay.parse(
      JSON.parse(readFileSync(join(ROOT, CODESHELL_PLUGIN_OVERLAY_FILE), "utf-8")),
    );
    expect(manifest.name).toBe("video-editor");
    expect("panels" in rawManifest).toBe(false);
    expect(overlay.panels?.entries[0].permissions).toContain("agent.submitPrompt");
    expect(overlay.automations?.templates[0]).toMatchObject({
      id: "daily-edit-audit",
      permissionLevel: "read-only",
      workspace: "current",
    });
    expect(manifest.interface?.defaultPrompt).toHaveLength(3);
    expect(manifest.interface?.defaultPrompt?.every((prompt) => prompt.length <= 128)).toBe(true);
  });

  test("installs into an isolated HOME and is discovered by canonical loaders", async () => {
    const home = mkdtempSync(join(tmpdir(), "video-editor-plugin-home-"));
    const project = mkdtempSync(join(tmpdir(), "video-editor-plugin-project-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    invalidateSkillCache();
    invalidatePluginCommandsCache();
    try {
      const installPath = await installPluginFromPath(
        ROOT,
        "video-editor",
        "2026-07-17T00:00:00.000Z",
      );
      const canonicalInstallPath = realpathSync(installPath);

      const catalog = loadPluginCatalog();
      expect(catalog).toHaveLength(1);
      expect(catalog[0]).toMatchObject({
        installKey: "video-editor@local",
        name: "video-editor",
        installPath: canonicalInstallPath,
        panels: [
          expect.objectContaining({
            id: "video-cut",
            entry: "panels/video-cut/index.html",
          }),
        ],
        automationTemplates: [
          expect.objectContaining({
            id: "daily-edit-audit",
            permissionLevel: "read-only",
          }),
        ],
      });
      expect(loadPluginPanelContributions()).toEqual([
        expect.objectContaining({
          pluginName: "video-editor",
          panel: expect.objectContaining({ id: "video-cut" }),
        }),
      ]);
      expect(loadPluginAutomationTemplateContributions()).toEqual([
        expect.objectContaining({
          installKey: "video-editor@local",
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
          template: expect.objectContaining({ id: "daily-edit-audit" }),
        }),
      ]);

      const skill = scanSkills(project).find((entry) => entry.name === "video-editor:video-editor");
      expect(skill).toMatchObject({
        source: "plugin",
        filePath: join(canonicalInstallPath, "skills", "video-editor", "SKILL.md"),
      });
      expect(skill?.content).toContain("bundled deterministic editor");

      const command = scanPluginCommands().find((entry) => entry.name === "video-editor:edit");
      expect(command).toMatchObject({
        pluginName: "video-editor",
        commandName: "edit",
        argumentHint: '<input-video> "<edit request>"',
      });
      expect(command?.body).toContain("wait for confirmation before rendering");

      const inventory = describePluginContent("video-editor", installPath, "video-editor@local");
      expect(inventory.skills).toEqual([
        expect.objectContaining({
          name: "video-editor",
          description: expect.stringContaining("trim"),
        }),
      ]);
      expect(inventory.commands).toEqual(["edit"]);
      expect(inventory.panels).toEqual([
        expect.objectContaining({
          id: "video-cut",
          permissions: expect.arrayContaining(["agent.submitPrompt"]),
        }),
      ]);
      expect(inventory.automationTemplates).toEqual([
        expect.objectContaining({
          id: "daily-edit-audit",
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
    } finally {
      invalidateSkillCache();
      invalidatePluginCommandsCache();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("parses timecodes and chains audio tempo safely", () => {
    expect(parseTimecode("01:02:03.500")).toBe(3723.5);
    expect(parseTimecode("02:03.250")).toBe(123.25);
    expect(parseFrameTimes("0.5,00:02,0.5")).toEqual([0.5, 2]);
    expect(() =>
      parseFrameTimes(Array.from({ length: 25 }, (_, index) => String(index)).join(",")),
    ).toThrow(/between 1 and 24/);
    expect(buildAtempoFilter(4)).toBe("atempo=2,atempo=2");
    expect(buildAtempoFilter(0.25)).toBe("atempo=0.5,atempo=0.5");
  });

  test("ships a review-first Desktop slash command", () => {
    const prompt = readFileSync(join(ROOT, "prompts", "edit.md"), "utf-8");
    const expanded = expandPluginCommandBody(
      prompt,
      '"/tmp/source clip.mp4" "trim it to a vertical teaser"',
    );
    expect(expanded).toContain("Source video: /tmp/source clip.mp4");
    expect(expanded).toContain("Requested edit: trim it to a vertical teaser");
    expect(expanded).toContain("wait for confirmation before rendering");
    expect(expanded).not.toContain("$1");
    expect(expanded).not.toContain("$2");
  });

  test("builds a shell-free multi-clip vertical render command", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-editor-test-"));
    const input = join(dir, "input.mp4");
    const output = join(dir, "output.mp4");
    writeFileSync(input, "fixture");
    const plan = normalizePlan({
      input,
      output,
      clips: [
        { start: 1, end: 3 },
        { start: 5, end: 8 },
      ],
      video: { aspect: "9:16", fit: "cover", speed: 2 },
      audio: { volume: 0.8 },
    });
    try {
      const command = buildRenderCommand(plan, {
        format: { duration: "10" },
        streams: [
          { codec_type: "video", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac" },
        ],
      });
      expect(command.command).toBe("ffmpeg");
      expect(command.args).toContain("-filter_complex");
      const filters = command.args[command.args.indexOf("-filter_complex") + 1];
      expect(filters).toContain("concat=n=2:v=1:a=1");
      expect(filters).toContain("scale=1080:1920");
      expect(filters).toContain("atempo=2");
      expect(filters).toContain("setsar=1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects audio-only inputs before constructing video filtergraphs", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-editor-audio-only-"));
    const input = join(dir, "input.m4a");
    writeFileSync(input, "fixture");
    const probe = {
      format: { duration: "3" },
      streams: [{ codec_type: "audio", codec_name: "aac" }],
    };
    try {
      expect(() =>
        buildRenderCommand(normalizePlan({ input, output: join(dir, "output.mp4") }), probe),
      ).toThrow(/input does not contain a video stream/);
      expect(() => buildFrameCommands(input, join(dir, "frames"), [0.5], probe)).toThrow(
        /input does not contain a video stream/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts only non-empty, single-link video outputs after rendering", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-editor-output-validation-"));
    const input = join(dir, "input.mp4");
    const output = join(dir, "output.mp4");
    const empty = join(dir, "empty.mp4");
    const audioOnly = join(dir, "audio-only.m4a");
    const hardLinked = join(dir, "hard-linked.mp4");
    writeFileSync(input, "source");
    writeFileSync(output, "rendered-video");
    writeFileSync(empty, "");
    writeFileSync(audioOnly, "rendered-audio");
    const videoProbe = {
      format: { duration: "2" },
      streams: [{ codec_type: "video", width: 320, height: 180 }],
    };
    try {
      expect(validateRenderedOutput(input, output, videoProbe)).toMatchObject({
        hasVideo: true,
        width: 320,
        height: 180,
      });
      expect(() => validateRenderedOutput(input, empty, videoProbe)).toThrow(/is empty/);
      expect(() =>
        validateRenderedOutput(input, audioOnly, {
          format: { duration: "2" },
          streams: [{ codec_type: "audio" }],
        }),
      ).toThrow(/rendered output does not contain a video stream/);
      linkSync(output, hardLinked);
      expect(() => validateRenderedOutput(input, hardLinked, videoProbe)).toThrow(
        /multiple hard links/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds bounded video and audio crossfades between reviewed clips", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-editor-transition-"));
    const input = join(dir, "input.mp4");
    writeFileSync(input, "fixture");
    try {
      const plan = normalizePlan({
        input,
        output: join(dir, "output.mp4"),
        clips: [
          { start: 0, end: 2 },
          { start: 3, end: 5.5 },
          { start: 6, end: 8 },
        ],
        video: { transition: { type: "fade", duration: 0.25 } },
      });
      const command = buildRenderCommand(plan, {
        format: { duration: "10" },
        streams: [{ codec_type: "video" }, { codec_type: "audio" }],
      });
      const filters = command.args[command.args.indexOf("-filter_complex") + 1];
      expect(filters).toContain("[v0][v1]xfade=transition=fade:duration=0.25:offset=1.75[vx1]");
      expect(filters).toContain("[vx1][v2]xfade=transition=fade:duration=0.25:offset=4[vx2]");
      expect(filters).toContain("[a0][a1]acrossfade=d=0.25:c1=tri:c2=tri[ax1]");
      expect(filters).toContain("[ax1][a2]acrossfade=d=0.25:c1=tri:c2=tri[ax2]");
      expect(filters).toContain("[vx2]setsar=1,format=yuv420p[vout]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid or impossible transition plans", () => {
    const base = { input: "/tmp/input.mp4", output: "/tmp/output.mp4" };
    expect(() =>
      normalizePlan({
        ...base,
        clips: [{ start: 0, end: 2 }],
        video: { transition: { type: "fade" } },
      }),
    ).toThrow(/at least two clips/);
    expect(() =>
      normalizePlan({
        ...base,
        clips: [
          { start: 0, end: 0.2 },
          { start: 1, end: 2 },
        ],
        video: { transition: { type: "fade", duration: 0.25 } },
      }),
    ).toThrow(/must be longer/);
    expect(() =>
      normalizePlan({
        ...base,
        clips: [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
        ],
        video: { transition: { type: "wipe", duration: 0.1 } },
      }),
    ).toThrow(/cut or fade/);
    expect(() =>
      normalizePlan({
        ...base,
        clips: [
          { start: 0, end: 6 },
          { start: 7, end: 13 },
        ],
        video: { transition: { type: "fade", duration: 5.1 } },
      }),
    ).toThrow(/must be <= 5/);
  });

  test("rejects unsafe encoding identifiers, oversized arrays, dimensions, and paths", () => {
    const base = { input: "/tmp/input.mp4", output: "/tmp/output.mp4" };
    expect(() => normalizePlan({ ...base, encoding: { videoCodec: "-y" } })).toThrow(
      /encoding\.videoCodec/,
    );
    expect(() => normalizePlan({ ...base, encoding: { audioCodec: "aac\n-map" } })).toThrow(
      /encoding\.audioCodec/,
    );
    expect(() => normalizePlan({ ...base, encoding: { preset: "x".repeat(65) } })).toThrow(
      /encoding\.preset/,
    );
    expect(() =>
      normalizePlan({
        ...base,
        clips: Array.from({ length: 257 }, () => ({ start: 0, end: 1 })),
      }),
    ).toThrow(/at most 256/);
    expect(() => normalizePlan({ ...base, video: { width: 16386, height: 1080 } })).toThrow(
      /16384/,
    );
    expect(() => normalizePlan({ input: `/tmp/source\n.mp4`, output: "/tmp/output.mp4" })).toThrow(
      /control characters/,
    );
    expect(() =>
      normalizePlan({ input: `/tmp/${"x".repeat(4096)}`, output: "/tmp/output.mp4" }),
    ).toThrow(/at most 4096/);
  });

  test("requires regular input and subtitle files", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-editor-regular-files-"));
    const input = join(dir, "input.mp4");
    const inputDirectory = join(dir, "input-directory");
    const subtitleDirectory = join(dir, "subtitles");
    writeFileSync(input, "fixture");
    mkdirSync(inputDirectory);
    mkdirSync(subtitleDirectory);
    try {
      const probe = {
        format: { duration: "3" },
        streams: [{ codec_type: "video", width: 320, height: 180 }],
      };
      expect(() =>
        buildRenderCommand(
          normalizePlan({ input: inputDirectory, output: join(dir, "bad.mp4") }),
          probe,
        ),
      ).toThrow(/input must be a regular file/);
      expect(() =>
        buildRenderCommand(
          normalizePlan({
            input,
            output: join(dir, "bad-subtitles.mp4"),
            subtitles: { path: subtitleDirectory },
          }),
          probe,
        ),
      ).toThrow(/subtitle file must be a regular file/);

      if (process.platform !== "win32") {
        const inputLink = join(dir, "input-link.mp4");
        const subtitleFile = join(dir, "captions.srt");
        const subtitleLink = join(dir, "captions-link.srt");
        writeFileSync(subtitleFile, "fixture");
        symlinkSync(input, inputLink);
        symlinkSync(subtitleFile, subtitleLink);
        expect(() =>
          buildRenderCommand(
            normalizePlan({ input: inputLink, output: join(dir, "linked-input.mp4") }),
            probe,
          ),
        ).toThrow(/input must not be a symbolic link/);
        expect(() =>
          buildRenderCommand(
            normalizePlan({
              input,
              output: join(dir, "linked-subtitles.mp4"),
              subtitles: { path: subtitleLink },
            }),
            probe,
          ),
        ).toThrow(/subtitle file must not be a symbolic link/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never overwrites output symlinks, special files, or aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-editor-output-safety-"));
    const input = join(dir, "input.mp4");
    const target = join(dir, "target.mp4");
    const hardLink = join(dir, "hard-link.mp4");
    const multiLink = join(dir, "target-hard-link.mp4");
    const existing = join(dir, "existing.mp4");
    const outputDirectory = join(dir, "output-directory.mp4");
    writeFileSync(input, "fixture");
    writeFileSync(target, "target");
    writeFileSync(existing, "existing");
    linkSync(input, hardLink);
    linkSync(target, multiLink);
    mkdirSync(outputDirectory);
    const probe = {
      format: { duration: "3" },
      streams: [{ codec_type: "video", width: 320, height: 180 }],
    };
    try {
      expect(() =>
        buildRenderCommand(normalizePlan({ input, output: hardLink, overwrite: true }), probe),
      ).toThrow(/resolves to the input file/);
      expect(() =>
        buildRenderCommand(
          normalizePlan({ input, output: outputDirectory, overwrite: true }),
          probe,
        ),
      ).toThrow(/must be a regular file/);
      expect(() =>
        buildRenderCommand(normalizePlan({ input, output: target, overwrite: true }), probe),
      ).toThrow(/multiple hard links/);
      expect(() => buildRenderCommand(normalizePlan({ input, output: existing }), probe)).toThrow(
        /already exists/,
      );
      expect(
        buildRenderCommand(normalizePlan({ input, output: existing, overwrite: true }), probe)
          .args[0],
      ).toBe("-y");

      if (process.platform !== "win32") {
        const outputLink = join(dir, "output-link.mp4");
        const linkedOutputParent = join(dir, "linked-output-parent");
        symlinkSync(target, outputLink);
        symlinkSync(dir, linkedOutputParent);
        expect(() =>
          buildRenderCommand(normalizePlan({ input, output: outputLink, overwrite: true }), probe),
        ).toThrow(/output must not be a symbolic link/);
        expect(() =>
          buildRenderCommand(
            normalizePlan({
              input,
              output: join(linkedOutputParent, "nested", "output.mp4"),
            }),
            probe,
          ),
        ).toThrow(/output parent must not contain a symbolic-link directory/);
        expect(readFileSync(target, "utf-8")).toBe("target");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds bounded shell-free visual-QA frame commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-editor-frames-"));
    const input = join(dir, "input.mp4");
    const outputDir = join(dir, "frames");
    const probe = {
      format: { duration: "3" },
      streams: [{ codec_type: "video", width: 320, height: 180 }],
    };
    writeFileSync(input, "fixture");
    try {
      const built = buildFrameCommands(input, outputDir, [0.5, 2], probe, false);
      expect(built.commands).toHaveLength(2);
      expect(built.commands[0]?.command).toBe("ffmpeg");
      expect(built.commands[0]?.args).toContain("-frames:v");
      expect(built.commands[0]?.output).toBe(join(outputDir, "frame-001.jpg"));
      expect(() => buildFrameCommands(input, outputDir, [4], probe, false)).toThrow(
        /exceeds source duration/,
      );
      expect(() => buildFrameCommands(input, outputDir, [], {}, false)).toThrow(/between 1 and 24/);
      expect(() =>
        buildFrameCommands(
          input,
          outputDir,
          Array.from({ length: 25 }, () => 0),
          {},
          false,
        ),
      ).toThrow(/between 1 and 24/);
      expect(() => buildFrameCommands(input, outputDir, [-1], {}, false)).toThrow(/must be >= 0/);

      mkdirSync(outputDir);
      mkdirSync(join(outputDir, "frame-001.jpg"));
      expect(() => buildFrameCommands(input, outputDir, [0.5], probe, true)).toThrow(
        /frame output must be a regular file/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects frame output directory and file symlinks", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "video-editor-frame-links-"));
    const input = join(dir, "input.mp4");
    const realFrames = join(dir, "real-frames");
    const linkedFrames = join(dir, "linked-frames");
    const brokenFrames = join(dir, "broken-frames");
    const linkedAncestor = join(dir, "linked-ancestor");
    const target = join(dir, "target.jpg");
    const probe = { streams: [{ codec_type: "video", width: 320, height: 180 }] };
    writeFileSync(input, "fixture");
    writeFileSync(target, "target");
    mkdirSync(realFrames);
    symlinkSync(realFrames, linkedFrames);
    symlinkSync(join(dir, "missing-frames"), brokenFrames);
    symlinkSync(dir, linkedAncestor);
    try {
      expect(() => buildFrameCommands(input, linkedFrames, [0.5], {}, true)).toThrow(
        /output directory must not be a symbolic link/,
      );
      expect(() => buildFrameCommands(input, brokenFrames, [0.5], {}, true)).toThrow(
        /output directory must not be a symbolic link/,
      );
      expect(() =>
        buildFrameCommands(input, join(linkedAncestor, "new-frames"), [0.5], {}, true),
      ).toThrow(/output directory parent must not contain a symbolic-link directory/);

      symlinkSync(target, join(realFrames, "frame-001.jpg"));
      expect(() => buildFrameCommands(input, realFrames, [0.5], probe, true)).toThrow(
        /frame output must not be a symbolic link/,
      );
      expect(readFileSync(target, "utf-8")).toBe("target");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("escapes subtitle filtergraph metacharacters without a shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-editor-subtitle-path-"));
    const input = join(dir, "input clip.mp4");
    const subtitles = join(dir, "captions,semi;[x]' quote.srt");
    writeFileSync(input, "fixture");
    writeFileSync(subtitles, "fixture");
    try {
      const built = buildRenderCommand(
        normalizePlan({
          input,
          output: join(dir, "output clip.mp4"),
          subtitles: { path: subtitles },
        }),
        {
          format: { duration: "3" },
          streams: [{ codec_type: "video", width: 320, height: 180 }],
        },
      );
      const filters = built.args[built.args.indexOf("-filter_complex") + 1];
      expect(filters).toContain("subtitles=filename='");
      expect(filters).toContain("\\,");
      expect(filters).toContain("\\;");
      expect(filters).toContain("\\[");
      expect(filters).toContain("\\'");
      expect(built.command).toBe("ffmpeg");
      expect(built.args).not.toContain("sh");
      expect(built.args).not.toContain("-c");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renders and probes a real multi-clip fixture when FFmpeg is available", () => {
    const available = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (available.status !== 0) return;

    const dir = mkdtempSync(join(tmpdir(), "video-editor-integration-"));
    const input = join(dir, "input clip [1];$source.mp4");
    const output = join(dir, "output clip [1];$render.mp4");
    const subtitles = join(dir, "captions,semi;[x]' quote.srt");
    const plan = join(dir, "plan.json");
    try {
      const filterList = spawnSync("ffmpeg", ["-hide_banner", "-filters"], {
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      });
      const supportsSubtitles =
        filterList.status === 0 && /(?:^|\s)subtitles(?:\s|$)/m.test(filterList.stdout);
      const generated = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x180:rate=24:duration=3",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=3",
          "-shortest",
          "-c:v",
          "libx264",
          "-c:a",
          "aac",
          input,
        ],
        { encoding: "utf-8" },
      );
      expect(generated.status, generated.stderr).toBe(0);
      writeFileSync(subtitles, "1\n00:00:00,000 --> 00:00:02,500\nCodeShell subtitle safety\n");
      if (!supportsSubtitles) {
        const unsupportedPlan = join(dir, "unsupported-subtitles-plan.json");
        writeFileSync(
          unsupportedPlan,
          JSON.stringify({
            input,
            output: join(dir, "unsupported-subtitles.mp4"),
            subtitles: { path: subtitles },
          }),
        );
        const rejected = spawnSync(
          "node",
          [
            join(ROOT, "skills", "video-editor", "scripts", "video-editor.mjs"),
            "render",
            "--plan",
            unsupportedPlan,
          ],
          { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
        );
        expect(rejected.status).toBe(1);
        expect(rejected.stderr).toContain("does not provide the subtitles filter");
      }
      const editPlan: Record<string, unknown> = {
        input,
        output,
        clips: [
          { start: 0.25, end: 1 },
          { start: 1.5, end: 2.25 },
        ],
        video: {
          width: 180,
          height: 320,
          fit: "contain",
          transition: { type: "fade", duration: 0.1 },
        },
      };
      if (supportsSubtitles) editPlan.subtitles = { path: subtitles };
      writeFileSync(plan, JSON.stringify(editPlan));

      const rendered = spawnSync(
        "node",
        [
          join(ROOT, "skills", "video-editor", "scripts", "video-editor.mjs"),
          "render",
          "--plan",
          plan,
        ],
        { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
      );
      expect(rendered.status, rendered.stderr).toBe(0);

      const probed = spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_type,width,height,sample_aspect_ratio",
          "-of",
          "json",
          output,
        ],
        { encoding: "utf-8" },
      );
      expect(probed.status, probed.stderr).toBe(0);
      const outputProbe = JSON.parse(probed.stdout);
      const videoStream = outputProbe.streams.find(
        (stream: { codec_type?: string }) => stream.codec_type === "video",
      );
      expect(videoStream).toMatchObject({
        width: 180,
        height: 320,
        sample_aspect_ratio: "1:1",
      });
      expect(
        outputProbe.streams.some(
          (stream: { codec_type?: string }) => stream.codec_type === "audio",
        ),
      ).toBe(true);
      expect(Number(outputProbe.format.duration)).toBeGreaterThan(1.3);
      expect(Number(outputProbe.format.duration)).toBeLessThan(1.5);

      const frames = spawnSync(
        "node",
        [
          join(ROOT, "skills", "video-editor", "scripts", "video-editor.mjs"),
          "frames",
          "--input",
          output,
          "--output",
          join(dir, "QA frames [1];$safe"),
          "--at",
          "0.25,1",
        ],
        { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
      );
      expect(frames.status, frames.stderr).toBe(0);
      expect(JSON.parse(frames.stdout).frames).toHaveLength(2);
      expect(
        readFileSync(join(dir, "QA frames [1];$safe", "frame-001.jpg")).length,
      ).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
