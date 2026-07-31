/**
 * 数字人依赖：把 profile.requires 解析成「将要发生什么」的计划，供 UI 先展示、
 * 用户确认后再执行。
 *
 * 为什么需要这一层：plugins/skills/mcp/agents 四个字段只是 force-enable 开关，
 * 只能打开磁盘上已存在的能力。没有获取步骤，一个声明了 skill 的数字人在新机器上
 * 会静默变成空壳（能力名写着，实际什么都没启用）。
 *
 * 安全边界：安装会克隆远程仓库并执行 `npx skills add`，属于运行远程代码。本模块
 * 只负责**计划与校验**，从不自行执行；执行由 host 在拿到用户确认后驱动
 * ({@link buildSkillInstallArgs} 给出确切 argv)。
 */
import type { SkillRequirement, WorkspaceProfileRequirements } from "./types.js";

/** scanner 已发现的一条 skill（`plugin:skill` 形式代表插件来源）。 */
export interface KnownSkill {
  name: string;
  source: "project" | "user" | "plugin" | "panel-app";
}

export interface SkillConflict {
  name: string;
  /** 已占用该名字的来源。安装到 project 根后它会被遮蔽。 */
  existingSource: KnownSkill["source"];
}

export interface PlannedSkillInstall {
  requirement: SkillRequirement;
  /** 具名子集里确实缺失的那些；整仓安装（--all）时为 undefined。 */
  missing?: string[];
}

export type MissingToolReason = "not-found" | "too-old";

export interface MissingTool {
  bin: string;
  reason: MissingToolReason;
  /** reason=too-old 时实际探到的版本。 */
  found?: string;
  /** reason=too-old 时 profile 要求的版本。 */
  required?: string;
  hint?: string;
}

export interface ProfileRequirementPlan {
  skillInstalls: PlannedSkillInstall[];
  missingTools: MissingTool[];
  conflicts: SkillConflict[];
  /** 是否有需要用户确认后执行的安装动作。 */
  needsInstall: boolean;
}

export interface PlanRequirementsContext {
  /** 当前 scanner 能看到的全部 skill。 */
  installedSkills: readonly KnownSkill[];
  /** 探测一个外部命令的版本输出；不存在返回 null。 */
  toolProbe: (bin: string) => string | null;
}

/**
 * 组装 `npx skills add` 的 argv。
 *
 * 两条硬约束：
 * 1. **绝不加 `-g`** —— 全局安装落在 `~/.claude/skills`，而 scanner 只读
 *    `<cwd>/.code-shell/skills`、`<cwd>/.agents/skills`、`~/.code-shell/skills`
 *    三个根。装了却扫不到，就是又一个"配了等于没配"。
 * 2. repo 与 skill 名各自占独立 argv 槽，不拼 shell 字符串；配合 schema 的
 *    `SKILL_REPO_RE` 挡住 `--flag` / `../` / `;rm -rf` 一类注入。
 */
export function buildSkillInstallArgs(requirement: SkillRequirement): string[] {
  const args = ["skills", "add", requirement.repo];
  if (requirement.skills && requirement.skills.length > 0) {
    // 具名子集：只装需要的，避免把整个仓库几十个 skill 都拖进项目。
    args.push("--skill", requirement.skills.join(","), "--agent", "*", "--yes");
  } else {
    // --all === --skill '*' --agent '*' -y
    args.push("--all");
  }
  if (requirement.fullDepth) args.push("--full-depth");
  return args;
}

/** 从 `--version` 输出里取第一个点分版本号。 */
export function parseToolVersion(output: string): string | undefined {
  const match = /(\d+(?:\.\d+){0,2})/.exec(output);
  return match?.[1];
}

/** 按数字段比较；返回 <0 / 0 / >0。缺省段视为 0，故 "22" == "22.0.0"。 */
export function compareToolVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 找出即将安装的裸名与已有 skill 的撞名。
 *
 * scanner 的去重是「先到先得且静默」——同名后来者直接被丢弃，不告警。所以要在
 * 安装前把遮蔽关系摊开给用户看。插件 skill 带 `plugin:` 命名空间、走独立 dedup
 * 集合，永远不会与裸名互相覆盖，故排除。
 */
export function summarizeSkillConflicts(
  incoming: readonly string[],
  installed: readonly KnownSkill[],
): SkillConflict[] {
  const conflicts: SkillConflict[] = [];
  for (const name of incoming) {
    const hit = installed.find((s) => s.source !== "plugin" && s.name === name);
    if (hit) conflicts.push({ name, existingSource: hit.source });
  }
  return conflicts;
}

/** 纯函数：不碰磁盘、不起进程，全部输入经 context 注入，便于测试。 */
export function planProfileRequirements(
  requires: WorkspaceProfileRequirements | undefined,
  context: PlanRequirementsContext,
): ProfileRequirementPlan {
  const skillInstalls: PlannedSkillInstall[] = [];
  const conflicts: SkillConflict[] = [];
  const missingTools: MissingTool[] = [];

  for (const requirement of requires?.skills ?? []) {
    if (requirement.skills && requirement.skills.length > 0) {
      // 只有落在 project 根（安装目标）的同名 skill 才算"已具备"；命中更低优先级的
      // user 根不算——那份会被这次安装遮蔽，属于要提示的冲突而非可跳过的满足。
      const satisfied = (name: string): boolean =>
        context.installedSkills.some((s) => s.name === name && s.source === "project");
      const missing = requirement.skills.filter((name) => !satisfied(name));
      const shadowed = summarizeSkillConflicts(
        requirement.skills.filter((name) => !satisfied(name)),
        context.installedSkills,
      );
      conflicts.push(...shadowed);
      // 具名子集全在了就不必再跑安装。
      if (missing.length === 0) continue;
      // Keep the reviewed command and the executed argv aligned: if part of a
      // multi-Skill requirement is already present, only pass the genuinely
      // missing names to the installer. Re-sending the full authored subset
      // could unnecessarily replace a working project Skill while the UI said
      // it was only going to install the missing one.
      skillInstalls.push({
        requirement: { ...requirement, skills: missing },
        missing,
      });
    } else {
      // 整仓安装无法预判会带来哪些名字，只能照跑；`skills add` 自身是幂等的。
      skillInstalls.push({ requirement });
    }
  }

  for (const tool of requires?.tools ?? []) {
    const output = context.toolProbe(tool.bin);
    if (output === null) {
      missingTools.push({
        bin: tool.bin,
        reason: "not-found",
        ...(tool.hint ? { hint: tool.hint } : {}),
      });
      continue;
    }
    if (!tool.minVersion) continue;
    const found = parseToolVersion(output);
    if (found && compareToolVersions(found, tool.minVersion) < 0) {
      missingTools.push({
        bin: tool.bin,
        reason: "too-old",
        found,
        required: tool.minVersion,
        ...(tool.hint ? { hint: tool.hint } : {}),
      });
    }
  }

  return {
    skillInstalls,
    missingTools,
    conflicts,
    needsInstall: skillInstalls.length > 0,
  };
}
