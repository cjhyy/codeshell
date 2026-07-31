/**
 * 数字人依赖的 desktop 执行层。
 *
 * core 的 `profile/requirements.ts` 只做计划与校验（纯函数，不碰磁盘、不起进程）；
 * 真正跑 `npx skills add` 在这里。分层的理由是安装等于**执行远程代码**：计划可以
 * 随时算，执行必须先经用户确认。
 *
 * 调用顺序：planProfileRequirements() → formatRequirementPlan() 交 UI 确认 →
 * installSkillRequirement()。
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  SKILL_REPO_RE,
  buildSkillInstallArgs,
  type ProfileRequirementPlan,
  type SkillRequirement,
} from "@cjhyy/code-shell-core";

export type SkillInstallResult = { ok: true; stdout: string } | { ok: false; error: string };

/** 注入点：测试替换掉真实子进程。 */
export type SkillInstallRunner = (
  file: string,
  args: string[],
  cwd: string,
) => Promise<SkillInstallResult>;

/** `npx skills add` 会克隆仓库并写文件，给足超时但不无限等。 */
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_INSTALL_ERROR_CHARS = 2_400;

function conciseInstallError(raw: string): string {
  const cleaned = stripVTControlCharacters(raw)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!cleaned) return "安装失败，但安装器没有返回错误信息";
  if (cleaned.length <= MAX_INSTALL_ERROR_CHARS) return cleaned;
  const edge = Math.floor(MAX_INSTALL_ERROR_CHARS / 2);
  return `${cleaned.slice(0, edge)}\n…（安装日志过长，已省略中间内容）…\n${cleaned.slice(-edge)}`;
}

const defaultRunner: SkillInstallRunner = (file, args, cwd) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: (stderr || error.message).trim() });
          return;
        }
        resolve({ ok: true, stdout: stdout.trim() });
      },
    );
  });

/**
 * 执行一条 skill 依赖。
 *
 * 安全上这是最后一道门，故即使 schema 已经校验过也**重新校验** repo：这个值会
 * 变成子进程 argv，一旦放过 `--flag` 形态就等于让 profile 控制 CLI 行为。
 * 参数始终以数组传递，不经 shell。
 */
export async function installSkillRequirement(
  requirement: SkillRequirement,
  workspaceCwd: string,
  runner: SkillInstallRunner = defaultRunner,
): Promise<SkillInstallResult> {
  if (!SKILL_REPO_RE.test(requirement.repo)) {
    return { ok: false, error: `拒绝安装：非法的 skill 仓库 "${requirement.repo}"` };
  }
  if (!isAbsolute(workspaceCwd)) {
    return { ok: false, error: "拒绝安装：需要绝对路径的工作区" };
  }
  // `--yes` 是 npx 自己的「别提示是否下载 skills 包」；skills CLI 的 --yes 由
  // buildSkillInstallArgs 负责，两者不是同一个。
  const result = await runner(
    "npx",
    ["--yes", ...buildSkillInstallArgs(requirement)],
    workspaceCwd,
  );
  return result.ok ? result : { ok: false, error: conciseInstallError(result.error) };
}

export interface RequirementPlanSummary {
  /** 确认后将要执行的动作，逐条人类可读。 */
  willRun: string[];
  /** 不阻断安装，但用户该知道的（例如同名 skill 被遮蔽）。 */
  warnings: string[];
  /** 装不了的外部依赖；安装本身仍可进行，但数字人不会完整可用。 */
  blockers: string[];
}

/** Render argv for review only. Execution still uses execFile with separate argv slots. */
function formatReviewedCommand(file: string, args: readonly string[]): string {
  const quote = (value: string) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
  return [file, ...args].map(quote).join(" ");
}

/** 把计划摊成确认弹窗要显示的三段文字。UI 不该自己拼这些语义。 */
export function formatRequirementPlan(plan: ProfileRequirementPlan): RequirementPlanSummary {
  const willRun = plan.skillInstalls.map(({ requirement, missing }) => {
    const which = missing?.length ? missing.join("、") : "全部 skill";
    const command = formatReviewedCommand("npx", ["--yes", ...buildSkillInstallArgs(requirement)]);
    return `从 ${requirement.repo} 安装 ${which} 到项目 .agents/skills\n${command}`;
  });

  const sourceLabel = (source: ProfileRequirementPlan["conflicts"][number]["existingSource"]) => {
    switch (source) {
      case "user":
        return "用户级目录";
      case "panel-app":
        return "已安装的扩展";
      case "plugin":
        return "插件";
      case "project":
        return "项目级目录";
    }
  };
  const warnings = plan.conflicts.map(
    ({ name, existingSource }) =>
      `"${name}" 已存在于${sourceLabel(existingSource)}，安装后将被本次的项目级版本遮蔽`,
  );

  const blockers = plan.missingTools.map((tool) => {
    const base =
      tool.reason === "not-found"
        ? `缺少外部命令 ${tool.bin}`
        : `${tool.bin} 版本过低：需要 ≥${tool.required}，当前 ${tool.found}`;
    return tool.hint ? `${base}（${tool.hint}）` : base;
  });

  return { willRun, warnings, blockers };
}
