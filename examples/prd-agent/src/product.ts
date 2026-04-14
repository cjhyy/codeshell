/**
 * PRD Agent 产品定义
 *
 * 把 preset + adapter + contract 组装成一个可复用的产品实例。
 * 其他入口（chat.ts、API server、CI）都 import 这个模块。
 */
import { defineProduct, type ProductInstance } from "../../src/index.js";
import { prdTools } from "./tools.js";
import { PRDEvaluator } from "./evaluator.js";

export interface PRDAgentOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export function createPRDAgent(options: PRDAgentOptions): ProductInstance {
  return defineProduct(
    {
      // ── Preset（大脑）──────────────────────────────────────────
      preset: {
        name: "prd-writer",
        label: "PRD Writer Agent",
        description: "Generates structured PRD documents through conversational interaction.",
        sections: ["base", "orchestration"],
        appendPrompt: `You are a senior product manager AI assistant. Your job is to help users create high-quality PRD (Product Requirements Document) through conversation.

## Your workflow:

1. **Understand** — Ask clarifying questions about the product vision, target users, and problem being solved. Don't start writing until you have enough context.

2. **Research** — Use CompetitorResearch to understand the competitive landscape. This informs your feature prioritization.

3. **Draft** — Use LoadTemplate to get the PRD template structure, then fill in each section based on the conversation.

4. **Save** — Use SavePRD to save the final document. The filename should be descriptive, like "user-auth-system-prd.md".

## Important rules:

- Write PRDs in Chinese (用中文写 PRD)
- Prioritize features as P0/P1/P2 with clear criteria
- Every feature must trace back to a user scenario
- Non-functional requirements must have measurable targets (e.g. "P99 latency < 200ms")
- Milestones should be concrete, not vague ("Phase 1: 3 weeks" not "Phase 1: soon")
- Always include acceptance criteria for each P0 feature`,
      },

      // ── Adapter（双手）─────────────────────────────────────────
      adapter: {
        tools: prdTools,
        enableTools: ["Read", "Glob", "Grep"],
        disableTools: ["Bash", "Write", "Edit", "NotebookEdit", "LSP", "EnterWorktree", "ExitWorktree"],
        permissionRules: [
          { tool: "LoadTemplate", decision: "allow" },
          { tool: "SavePRD", decision: "allow" },
          { tool: "CompetitorResearch", decision: "allow" },
        ],
      },

      // ── Contract（契约）────────────────────────────────────────
      contract: {
        evaluator: new PRDEvaluator(),
        maxTurns: 30,
        defaultTags: ["prd", "product"],
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
    },
  );
}
