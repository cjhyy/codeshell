/**
 * PRD Agent 自定义工具
 *
 * 这些工具让 LLM 能够：
 *   - 读取 PRD 模板
 *   - 保存生成的 PRD 文档
 *   - 搜索竞品信息（模拟）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { CustomTool } from "../../src/index.js";

const ROOT = resolve(import.meta.dir, "..");

// ─── LoadTemplate ───────────────────────────────────────────────

export const loadTemplateTool: CustomTool = {
  definition: {
    name: "LoadTemplate",
    description: "Load a PRD markdown template. Returns the template content with placeholder tags like {title}, {background}, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        template_name: {
          type: "string",
          description: "Template filename without extension. Default: 'prd-template'",
        },
      },
    },
  },
  execute: async (args) => {
    const name = (args.template_name as string) || "prd-template";
    const templatesDir = resolve(ROOT, "templates");
    const path = resolve(templatesDir, `${name}.md`);
    if (!path.startsWith(templatesDir + sep)) {
      return `Error: template name '${name}' escapes templates directory`;
    }
    if (!existsSync(path)) {
      return `Error: Template '${name}' not found at ${path}`;
    }
    return readFileSync(path, "utf-8");
  },
};

// ─── SavePRD ────────────────────────────────────────────────────

export const savePRDTool: CustomTool = {
  definition: {
    name: "SavePRD",
    description: "Save the generated PRD document to the output directory. Returns the saved file path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description: "Output filename, e.g. 'user-auth-prd.md'",
        },
        content: {
          type: "string",
          description: "The full PRD markdown content",
        },
      },
      required: ["filename", "content"],
    },
  },
  execute: async (args) => {
    const filename = args.filename as string;
    const content = args.content as string;
    if (!filename || typeof filename !== "string") {
      return "Error: filename is required";
    }
    const outDir = resolve(ROOT, "output");
    const outPath = resolve(outDir, filename);
    if (!outPath.startsWith(outDir + sep)) {
      return `Error: filename '${filename}' escapes output directory`;
    }
    writeFileSync(outPath, content, "utf-8");
    return `PRD saved to ${outPath} (${content.length} chars)`;
  },
};

// ─── CompetitorResearch ─────────────────────────────────────────

export const competitorResearchTool: CustomTool = {
  definition: {
    name: "CompetitorResearch",
    description: "Research competitor products in a given domain. Returns a structured summary of competitor features, pricing, and market position.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Product domain to research, e.g. 'project management', 'ai code editor'",
        },
        competitors: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of specific competitors to analyze",
        },
      },
      required: ["domain"],
    },
  },
  execute: async (args) => {
    const domain = args.domain as string;
    const competitors = (args.competitors as string[]) ?? [];

    // 实际业务中对接搜索 API 或内部知识库
    // 这里用模拟数据演示工具契约
    return JSON.stringify({
      domain,
      analyzed: competitors.length > 0 ? competitors : ["(auto-detected)"],
      insights: [
        `${domain} 市场规模持续增长，年复合增长率 15-25%`,
        "头部产品普遍采用 SaaS + 开源社区双轨策略",
        "AI 辅助功能成为新进入者的差异化关键",
        "用户最关注的维度：易用性 > 集成能力 > 价格",
      ],
      gaps: [
        "多数竞品缺乏中文本地化深度支持",
        "数据隐私合规（GDPR/个保法）仍是痛点",
      ],
    }, null, 2);
  },
};

// ─── 导出所有工具 ───────────────────────────────────────────────

export const prdTools: CustomTool[] = [
  loadTemplateTool,
  savePRDTool,
  competitorResearchTool,
];
