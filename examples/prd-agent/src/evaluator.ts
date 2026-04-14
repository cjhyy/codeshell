/**
 * PRD 质量评估器
 *
 * 在 Run 完成后自动检查生成的 PRD 是否符合质量标准：
 *   - 是否调用了 SavePRD（有产出）
 *   - 是否包含关键章节
 *   - 是否做了竞品研究
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Evaluator, EvaluatorContext, EvaluatorResult } from "../../src/index.js";

const OUTPUT_DIR = resolve(import.meta.dir, "..", "output");

const REQUIRED_SECTIONS = [
  "背景与目标",
  "用户场景",
  "功能需求",
  "非功能需求",
  "验收标准",
];

export class PRDEvaluator implements Evaluator {
  readonly name = "prd-quality";

  async evaluate(ctx: EvaluatorContext): Promise<EvaluatorResult> {
    const findings: string[] = [];

    // 1. 检查是否有产出文件
    const artifacts = ctx.artifacts.filter((a) => a.kind === "file" || a.kind === "document");
    const usedSavePRD = ctx.checkpoint.touchedTools.includes("SavePRD");

    if (!usedSavePRD && artifacts.length === 0) {
      findings.push("SavePRD was never called — no PRD document produced");
    }

    // 2. 尝试读取 output 目录里最新的 .md 文件，检查章节完整性
    if (existsSync(OUTPUT_DIR)) {
      const mdFiles = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".md"));
      if (mdFiles.length > 0) {
        const latest = mdFiles[mdFiles.length - 1];
        const content = readFileSync(join(OUTPUT_DIR, latest), "utf-8");

        for (const section of REQUIRED_SECTIONS) {
          if (!content.includes(section)) {
            findings.push(`Missing required section: "${section}"`);
          }
        }

        // 3. 检查文档长度
        if (content.length < 500) {
          findings.push(`PRD too short (${content.length} chars) — likely incomplete`);
        }
      }
    }

    // 4. 检查是否做了竞品调研
    const didResearch = ctx.checkpoint.touchedTools.includes("CompetitorResearch");
    if (!didResearch) {
      findings.push("CompetitorResearch was not called — PRD may lack market context");
    }

    const verdict = findings.filter((f) => !f.includes("CompetitorResearch")).length === 0
      ? (findings.length > 0 ? "warning" : "passed")
      : "failed";

    return { verdict, findings };
  }
}
