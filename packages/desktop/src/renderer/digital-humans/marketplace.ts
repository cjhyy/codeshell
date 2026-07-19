import type { CuratedDigitalHumanTeam, DigitalHumanProfileEntry } from "./types";

export const CURATED_DIGITAL_HUMAN_TEAMS: readonly CuratedDigitalHumanTeam[] = [
  {
    id: "product-discovery-squad",
    name: "产品探索团队",
    description: "从用户与竞品研究开始，完成产品判断、体验方案和独立质量复核。",
    category: "product",
    tags: ["产品探索", "用户研究", "体验评审"],
    members: ["product-researcher", "experience-designer", "quality-reviewer"],
    mode: "divide",
    samplePrompts: [
      "评估这个产品方向是否值得做，并给出用户、竞品、体验与风险结论",
      "从零规划这个功能：研究问题、设计体验并独立评审方案",
    ],
    usageCount: 4300,
  },
  {
    id: "software-delivery-squad",
    name: "软件交付团队",
    description: "由产品经理澄清范围，开发者实施，质量审阅员完成独立验收。",
    category: "engineering",
    tags: ["需求拆解", "软件开发", "质量验收"],
    members: ["product-manager", "software-builder", "quality-reviewer"],
    mode: "divide",
    samplePrompts: [
      "把这个需求从范围澄清、开发实现到质量验收完整交付",
      "分析这个缺陷，完成修复、测试和独立回归检查",
    ],
    usageCount: 7800,
  },
  {
    id: "data-decision-squad",
    name: "数据决策团队",
    description: "由数据分析师提炼证据，产品研究员解释业务含义，质量审阅员复核结论。",
    category: "engineering",
    tags: ["数据分析", "业务洞察", "结论复核"],
    members: ["data-analyst", "product-researcher", "quality-reviewer"],
    mode: "compare",
    samplePrompts: [
      "分析这份业务数据，解释关键变化并给出经过复核的行动建议",
      "建立核心指标框架，并从数据与业务两个视角验证它",
    ],
    usageCount: 3600,
  },
] as const;

export function profileSamplePrompts(profile: DigitalHumanProfileEntry): string[] {
  const subject = profile.description?.trim() || profile.label;
  return [
    `请以${profile.label}的工作方法分析这个任务：${subject}`,
    `先梳理目标、约束和交付标准，再由${profile.label}给出完整方案`,
  ];
}
