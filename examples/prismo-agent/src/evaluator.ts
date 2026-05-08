/**
 * Prismo structured evaluator.
 *
 * Two surfaces:
 *
 *   1. `evaluatePrismoBundle()` — pure function used by the `RunArtifactEvaluator`
 *      tool inside the agent loop. Returns the rich structured shape from the
 *      implementation plan ({ score, passed, findings[], suggestions[] }).
 *
 *   2. `PrismoArtifactEvaluator` — implements CodeShell's `Evaluator` contract
 *      so the RunManager can attach it to the contract and emit `evaluator_*`
 *      events after the run finishes. It re-uses (1) and projects the result
 *      into `EvaluatorResult` (verdict + findings + details).
 */

import type {
  Evaluator,
  EvaluatorContext,
  EvaluatorResult,
} from "../../../src/index.js";
import type { DraftArtifactRecord, PrismoProjectFixture } from "./fixtures.js";

// ─── Public structured result (matches plan §5.3) ──────────────────

export type Severity = "error" | "warning" | "info";

export interface PrismoFinding {
  severity: Severity;
  message: string;
  artifactId?: string;
  section?: string;
  category: "prd" | "flowchart" | "prototype" | "consistency";
}

export interface PrismoEvaluation {
  score: number;
  passed: boolean;
  findings: PrismoFinding[];
  suggestions: string[];
}

// ─── Required PRD sections ─────────────────────────────────────────

const REQUIRED_PRD_SECTIONS = [
  "概述",
  "问题",
  "目标用户",
  "功能",
  "范围",
  "用户流程",
  "成功指标",
];

const P0_BLOCK_PATTERN = /P0/;
const ACCEPTANCE_PATTERNS = [/验收标准/, /Acceptance Criteria/i];
const OPEN_QUESTIONS_PATTERNS = [/待确认问题/, /Open Questions/i];

// ─── Evaluator shards ──────────────────────────────────────────────

function evaluatePRD(prd: DraftArtifactRecord | undefined): PrismoFinding[] {
  const findings: PrismoFinding[] = [];

  if (!prd) {
    findings.push({
      severity: "error",
      category: "prd",
      message: "未生成 PRD draft（缺少 SaveDraftArtifact kind=prd 调用）",
    });
    return findings;
  }

  for (const section of REQUIRED_PRD_SECTIONS) {
    if (!prd.content.includes(section)) {
      findings.push({
        severity: "error",
        category: "prd",
        artifactId: prd.id,
        section,
        message: `PRD 缺少必填章节 "${section}"`,
      });
    }
  }

  if (P0_BLOCK_PATTERN.test(prd.content)) {
    const hasAcceptance = ACCEPTANCE_PATTERNS.some((p) => p.test(prd.content));
    if (!hasAcceptance) {
      findings.push({
        severity: "warning",
        category: "prd",
        artifactId: prd.id,
        message: "PRD 出现 P0 功能但未包含验收标准章节",
      });
    }
  }

  const hasOpenQuestions = OPEN_QUESTIONS_PATTERNS.some((p) => p.test(prd.content));
  if (!hasOpenQuestions) {
    findings.push({
      severity: "info",
      category: "prd",
      artifactId: prd.id,
      message: "PRD 没有“待确认问题”章节，建议保留以便用户确认",
    });
  }

  if (prd.content.length < 600) {
    findings.push({
      severity: "warning",
      category: "prd",
      artifactId: prd.id,
      message: `PRD draft 偏短 (${prd.content.length} chars)，可能内容不完整`,
    });
  }

  return findings;
}

function evaluateFlowcharts(
  prd: DraftArtifactRecord | undefined,
  flowcharts: DraftArtifactRecord[],
): PrismoFinding[] {
  const findings: PrismoFinding[] = [];

  if (flowcharts.length === 0) {
    findings.push({
      severity: "warning",
      category: "flowchart",
      message: "本次 run 未产出流程图 draft",
    });
    return findings;
  }

  for (const flow of flowcharts) {
    if (!flow.content.trim()) {
      findings.push({
        severity: "error",
        category: "flowchart",
        artifactId: flow.id,
        message: "流程图 Mermaid 源码为空",
      });
      continue;
    }
    if (!/graph |flowchart |sequenceDiagram|stateDiagram|journey/.test(flow.content)) {
      findings.push({
        severity: "warning",
        category: "flowchart",
        artifactId: flow.id,
        message: "Mermaid 内容看起来不是合法的流程图开头声明",
      });
    }
    if (!flow.title || flow.title.length < 4) {
      findings.push({
        severity: "info",
        category: "flowchart",
        artifactId: flow.id,
        message: "流程图缺少有意义的标题，建议补充",
      });
    }
  }

  // Light cross-link check between PRD and flowchart titles.
  if (prd) {
    const linked = flowcharts.some((f) => prd.content.includes(f.title));
    if (!linked) {
      findings.push({
        severity: "info",
        category: "consistency",
        message: "PRD 文本中没有引用任一流程图标题，可能没说明流程图对应哪个用户流程",
      });
    }
  }

  return findings;
}

function evaluatePrototypes(
  prd: DraftArtifactRecord | undefined,
  prototypes: DraftArtifactRecord[],
): PrismoFinding[] {
  const findings: PrismoFinding[] = [];

  for (const proto of prototypes) {
    const lower = proto.content.toLowerCase();
    if (!lower.includes("<html") || !lower.includes("</html>")) {
      findings.push({
        severity: "warning",
        category: "prototype",
        artifactId: proto.id,
        message: "原型不是完整 HTML 文档（缺少 <html>...</html>）",
      });
    }
    if (!/<button|<a |role=|onclick=/i.test(proto.content)) {
      findings.push({
        severity: "info",
        category: "prototype",
        artifactId: proto.id,
        message: "原型未包含明显的可交互控件（button/a/role/onclick）",
      });
    }
    if (prd && !prd.content.includes(proto.title)) {
      findings.push({
        severity: "info",
        category: "consistency",
        message: `PRD 中未提及原型“${proto.title}”所代表的页面`,
      });
    }
  }

  return findings;
}

// ─── Aggregator ────────────────────────────────────────────────────

interface EvaluateInput {
  project: PrismoProjectFixture;
  drafts: DraftArtifactRecord[];
}

export function evaluatePrismoBundle(input: EvaluateInput): PrismoEvaluation {
  const prd = input.drafts.find((d) => d.kind === "prd");
  const flowcharts = input.drafts.filter((d) => d.kind === "flowchart");
  const prototypes = input.drafts.filter((d) => d.kind === "prototype");

  const findings: PrismoFinding[] = [
    ...evaluatePRD(prd),
    ...evaluateFlowcharts(prd, flowcharts),
    ...evaluatePrototypes(prd, prototypes),
  ];

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;

  // Crude but stable score: 100 - (errors * 20) - (warnings * 5) - (info * 1).
  const score = Math.max(
    0,
    100 - errorCount * 20 - warningCount * 5 - infoCount * 1,
  );
  const passed = errorCount === 0 && warningCount <= 2;

  const suggestions: string[] = [];
  if (!prd) suggestions.push("先调用 SaveDraftArtifact 写一份 PRD draft");
  if (flowcharts.length === 0)
    suggestions.push("至少为核心用户流程生成 1 张 Mermaid 流程图");
  if (errorCount > 0)
    suggestions.push("修复所有 severity=error 的 findings 后再请求 approve");
  if (passed && warningCount > 0)
    suggestions.push("可以提交确认，但建议先处理 warning 项");

  return { score, passed, findings, suggestions };
}

// ─── CodeShell Evaluator adapter ───────────────────────────────────

export class PrismoArtifactEvaluator implements Evaluator {
  readonly name = "prismo-artifact";

  constructor(private readonly getDrafts: () => DraftArtifactRecord[]) {}

  async evaluate(_ctx: EvaluatorContext): Promise<EvaluatorResult> {
    const result = evaluatePrismoBundle({
      project: { id: "n/a", title: "n/a", description: "", ownerId: "n/a", phase: "prd_generation" },
      drafts: this.getDrafts(),
    });

    const verdict: EvaluatorResult["verdict"] = result.findings.some(
      (f) => f.severity === "error",
    )
      ? "failed"
      : result.findings.some((f) => f.severity === "warning")
        ? "warning"
        : "passed";

    return {
      verdict,
      findings: result.findings.map(
        (f) =>
          `[${f.category}/${f.severity}] ${f.message}${f.artifactId ? ` (artifact=${f.artifactId})` : ""}`,
      ),
      details: {
        score: result.score,
        passed: result.passed,
        suggestions: result.suggestions,
        rawFindings: result.findings,
      },
    };
  }
}
