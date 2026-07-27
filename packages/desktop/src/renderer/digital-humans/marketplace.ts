import type { CuratedDigitalHumanTeam, DigitalHumanProfileEntry } from "./types";

/**
 * 精选团队。
 *
 * **当前为空，这是有意的。** 原先的三个团队（产品探索 / 软件交付 / 数据决策）建立在
 * Pet-led teams 模型上，而 2026-07-18 的架构更正已用 Session-first 取代它：数字人
 * 直接创建并绑定项目 Session，协作只走 `SendMessageToSession`，不再有 Handoff 实体，
 * 也不暴露 Handoff UI。它们同时带着编造的 usageCount（4300 / 7800 / 3600），一并移除。
 *
 * 保留常量与读取模型，便于后续按 Session-first 语义重建团队时不必改调用点。
 */
export const CURATED_DIGITAL_HUMAN_TEAMS: readonly CuratedDigitalHumanTeam[] = [] as const;

export function profileSamplePrompts(profile: DigitalHumanProfileEntry): string[] {
  const subject = profile.description?.trim() || profile.label;
  return [
    `请以${profile.label}的工作方法分析这个任务：${subject}`,
    `先梳理目标、约束和交付标准，再由${profile.label}给出完整方案`,
  ];
}
