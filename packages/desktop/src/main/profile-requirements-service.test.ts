import { describe, expect, test } from "bun:test";
import {
  formatRequirementPlan,
  installSkillRequirement,
  type SkillInstallRunner,
} from "./profile-requirements-service.js";
import type { SkillRequirement } from "@cjhyy/code-shell-core";

const req = (patch: Partial<SkillRequirement> = {}): SkillRequirement => ({
  source: "github",
  repo: "heygen-com/hyperframes",
  scope: "project",
  fullDepth: false,
  ...patch,
});

describe("installSkillRequirement", () => {
  test("runs npx with the exact argv the planner produced", async () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const runner: SkillInstallRunner = async (file, args, cwd) => {
      calls.push({ file, args, cwd });
      return { ok: true, stdout: "installed" };
    };

    const result = await installSkillRequirement(req({ skills: ["media-use"] }), "/repo", runner);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("npx");
    // `--yes` here is npx's own "don't prompt to install the package" flag; the
    // skills CLI gets its own --yes from buildSkillInstallArgs.
    expect(calls[0].args).toEqual([
      "--yes",
      "skills",
      "add",
      "heygen-com/hyperframes",
      "--skill",
      "media-use",
      "--agent",
      "*",
      "--yes",
    ]);
    // Project scope: the CLI must run inside the workspace so files land in
    // <cwd>/.agents/skills, which the scanner reads.
    expect(calls[0].cwd).toBe("/repo");
  });

  test("never passes a global flag", async () => {
    let seen: string[] = [];
    await installSkillRequirement(req(), "/repo", async (_f, args) => {
      seen = args;
      return { ok: true, stdout: "" };
    });
    expect(seen).not.toContain("-g");
    expect(seen).not.toContain("--global");
  });

  test("surfaces a failing install instead of reporting success", async () => {
    const result = await installSkillRequirement(req(), "/repo", async () => ({
      ok: false,
      error: "network unreachable",
    }));
    expect(result).toEqual({ ok: false, error: "network unreachable" });
  });

  test("keeps install failures readable when a CLI returns ANSI or huge logs", async () => {
    const result = await installSkillRequirement(req(), "/repo", async () => ({
      ok: false,
      error: `\u001B[31mstart failure\u001B[0m\n${"noise".repeat(1_000)}\nfinal cause`,
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("start failure");
    expect(result.error).toContain("final cause");
    expect(result.error).toContain("已省略中间内容");
    expect(result.error).not.toContain("\u001B");
    expect(result.error.length).toBeLessThan(2_500);
  });

  test("rejects a repo that fails the schema guard before spawning anything", async () => {
    let spawned = false;
    const result = await installSkillRequirement(
      { ...req(), repo: "--version" },
      "/repo",
      async () => {
        spawned = true;
        return { ok: true, stdout: "" };
      },
    );
    expect(result.ok).toBe(false);
    // Defense in depth: the schema already guards this, but the executor must
    // re-check because it is the last gate before a child process.
    expect(spawned).toBe(false);
  });

  test("rejects a non-absolute workspace path", async () => {
    let spawned = false;
    const result = await installSkillRequirement(req(), "relative/path", async () => {
      spawned = true;
      return { ok: true, stdout: "" };
    });
    expect(result.ok).toBe(false);
    expect(spawned).toBe(false);
  });
});

describe("formatRequirementPlan", () => {
  test("describes installs, conflicts and missing tools for the confirm dialog", () => {
    const summary = formatRequirementPlan({
      skillInstalls: [{ requirement: req({ skills: ["media-use"] }), missing: ["media-use"] }],
      conflicts: [{ name: "media-use", existingSource: "user" }],
      missingTools: [
        { bin: "ffmpeg", reason: "not-found", hint: "brew install ffmpeg" },
        { bin: "node", reason: "too-old", found: "20.1.0", required: "22" },
      ],
      needsInstall: true,
    });

    expect(summary.willRun[0]).toContain("heygen-com/hyperframes");
    expect(summary.willRun[0]).toContain("media-use");
    expect(summary.willRun[0]).toContain(
      "npx --yes skills add heygen-com/hyperframes --skill media-use --agent '*' --yes",
    );
    expect(summary.warnings.join(" ")).toContain("media-use");
    expect(summary.blockers.join(" ")).toContain("ffmpeg");
    expect(summary.blockers.join(" ")).toContain("20.1.0");
    expect(summary.blockers.join(" ")).toContain("brew install ffmpeg");
  });

  test("an empty plan produces nothing to confirm", () => {
    const summary = formatRequirementPlan({
      skillInstalls: [],
      conflicts: [],
      missingTools: [],
      needsInstall: false,
    });
    expect(summary.willRun).toEqual([]);
    expect(summary.warnings).toEqual([]);
    expect(summary.blockers).toEqual([]);
  });

  test("names extension-provided Skill conflicts accurately", () => {
    const summary = formatRequirementPlan({
      skillInstalls: [{ requirement: req({ skills: ["media-use"] }), missing: ["media-use"] }],
      conflicts: [{ name: "media-use", existingSource: "panel-app" }],
      missingTools: [],
      needsInstall: true,
    });

    expect(summary.warnings).toEqual([
      '"media-use" 已存在于已安装的扩展，安装后将被本次的项目级版本遮蔽',
    ]);
  });
});
