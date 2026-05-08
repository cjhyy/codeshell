/**
 * Prismo Artifact Agent — defineProduct() composition.
 *
 * Mirrors `examples/prd-agent/src/product.ts` but oriented at Prismo's three
 * artifact kinds (PRD / flowchart / prototype) and three workflows
 * (prd_bundle / revision_sprint / consistency_audit). Only `prd_bundle` is
 * driven end-to-end in Phase 0; the system prompt explicitly steers the agent
 * along the read-context → save-drafts → evaluate path.
 */

import { defineProduct, type ProductInstance } from "../../../src/index.js";
import { prismoTools, runStore } from "./tools.js";
import { PrismoArtifactEvaluator } from "./evaluator.js";

export interface PrismoAgentOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  cwd?: string;
  runsDir?: string;
}

export function createPrismoAgent(options: PrismoAgentOptions): ProductInstance {
  return defineProduct(
    {
      preset: {
        name: "prismo-artifact-agent",
        label: "Prismo Artifact Agent",
        description:
          "围绕 Prismo 项目 PRD / 流程图 / UI 原型推进 artifact 工作流的产品文档 Agent。",
        sections: ["base", "orchestration"],
        injectGitStatus: false,
        appendPrompt: `
你是 Prismo 的产品文档 Agent，目标是推进项目 artifact：PRD、流程图、UI 原型。

## 工作流

每次 run 都按这个顺序工作：

1. 调用 \`LoadPrismoContext\` 读取 project / messages / inputSources / artifacts。
   不允许跳过这一步直接写 artifact。
2. 根据当前 workflow 决定要产出什么：
   - workflow=prd_bundle      → PRD draft + 1~3 张流程图 draft + 0~2 个 UI 原型 draft
   - workflow=revision_sprint → 仅修订用户指定的 artifact，输出变更摘要
   - workflow=consistency_audit → 不写 artifact，只输出一致性 findings
3. 每个产物用 \`SaveDraftArtifact\` 写入 run draft（绝不直接覆盖正式 artifact）。
4. 全部产出完成后调用 \`RunArtifactEvaluator\`，把 findings 摘要写进最终回复。
5. 在最终回复里包含：变更摘要、产物列表、待确认问题（open questions）。

## 硬性规则

- 所有 PRD 必须包含章节：概述 / 问题 / 目标用户 / 功能 / 范围 / 用户流程 / 成功指标。
- 任何 P0 功能必须配“验收标准”。
- 流程图用 Mermaid 写在 SaveDraftArtifact 的 content 里，要带 \`graph TD\` 或 \`sequenceDiagram\` 等合法开头。
- 原型必须是完整 HTML 文档（含 <html>…</html>），并出现明显的可交互控件。
- 如果信息不足以下结论，把它列入 “待确认问题”，不要瞎编。
- 用中文输出 PRD。
`.trim(),
      },

      adapter: {
        tools: prismoTools,
        // Prismo agent should not roam the local FS or shell — it's a managed agent
        // operating on Prismo data via custom tools.
        disableTools: [
          "Bash",
          "Write",
          "Edit",
          "NotebookEdit",
          "Glob",
          "Grep",
          "Read",
          "EnterWorktree",
          "ExitWorktree",
        ],
        permissionRules: [
          { tool: "LoadPrismoContext", decision: "allow" },
          { tool: "SaveDraftArtifact", decision: "allow" },
          { tool: "RunArtifactEvaluator", decision: "allow" },
        ],
      },

      contract: {
        evaluator: new PrismoArtifactEvaluator(() => runStore.listDrafts()),
        defaultTags: ["prismo", "artifact-agent"],
        maxTurns: 20,
        concurrency: 1,
      },
    },
    {
      llm: {
        provider: "openai",
        model: options.model ?? "gpt-4o-mini",
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
      },
      cwd: options.cwd,
      runsDir: options.runsDir,
      permissionMode: "bypassPermissions",
    },
  );
}
