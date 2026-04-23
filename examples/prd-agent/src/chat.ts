/**
 * PRD Agent — 模拟后端服务的多轮 Chat
 *
 * 架构等价关系：
 *   CLI TUI (Ink)         ←→ 这个服务
 *   Mac 桌面端 (Electron) ←→ 这个服务
 *   Web 前端 (React)      ←→ 这个服务
 *
 * 它们共享同一个 Engine 内核，区别只在 I/O 形态。
 *
 * 运行: bun examples/prd-agent/src/chat.ts
 */
import { Engine, type EngineConfig, type EngineResult, type StreamEvent } from "../../../src/index.js";
import { prdTools } from "./tools.js";
import { PRDEvaluator } from "./evaluator.js";
import * as readline from "node:readline";

// ─── 配置 ───────────────────────────────────────────────────────

const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("请设置 OPENAI_API_KEY 或 OPENROUTER_API_KEY");
  process.exit(1);
}

// Default model depends on the provider:
//  - OpenRouter routes models by "<provider>/<model>" slugs. We pick
//    gpt-4.1-mini because gpt-4o-mini's OpenRouter Azure route frequently
//    rejects function-calling requests with 401.
//  - Direct OpenAI API uses the unprefixed model id.
const isOpenRouter = !!process.env.OPENROUTER_API_KEY;
const defaultModel = isOpenRouter ? "openai/gpt-4.1-mini" : "gpt-4o-mini";

const engineConfig: EngineConfig = {
  llm: {
    provider: "openai",
    model: process.env.MODEL ?? defaultModel,
    apiKey,
    baseUrl: isOpenRouter ? "https://openrouter.ai/api/v1" : undefined,
    enableStreaming: true,
  },
  cwd: process.cwd(),
  maxTurns: 30,
  maxContextTokens: 200_000,
  permissionMode: "bypassPermissions",
  preset: "general",
  customSystemPrompt: `You are a senior product manager AI. Help users create PRD documents through conversation.

## Available custom tools:
- LoadTemplate: Load PRD markdown template
- SavePRD: Save the generated PRD to disk
- CompetitorResearch: Research competitor products

## Workflow:
1. Ask clarifying questions about the product (target users, core problem, scope)
2. Use CompetitorResearch when you have enough context
3. Use LoadTemplate to get the PRD structure
4. Fill in each section based on the conversation
5. Use SavePRD to save the final document

## Rules:
- Write PRDs in Chinese
- Prioritize features as P0/P1/P2
- Be conversational — ask one question at a time, don't dump everything at once
- When the user says "生成" or "写PRD" or "开始写", proceed to generate`,
};

// ─── ChatService：模拟后端服务层 ────────────────────────────────

/**
 * 一个 ChatService 实例 = 一个用户的会话。
 * 你的后端为每个用户创建一个，通过 WebSocket/HTTP 接收消息。
 */
class ChatService {
  private engine: Engine;
  private sessionId: string | null = null;
  private turnCount = 0;

  constructor(config: EngineConfig) {
    this.engine = new Engine(config);

    // 注册自定义工具
    for (const tool of prdTools) {
      this.engine.registerCustomTool(tool.definition, tool.execute);
    }
  }

  /**
   * 发送一条消息，返回 Agent 的回复。
   * 每次调用会续接同一个 session（多轮对话）。
   *
   * 你的后端 API 大概长这样：
   *   POST /api/chat { message: "..." }
   *   → { reply: "...", sessionId: "...", turn: 3, toolsUsed: [...] }
   */
  async send(message: string): Promise<{
    reply: string;
    sessionId: string;
    turn: number;
    toolsUsed: string[];
    tokensUsed: number;
  }> {
    this.turnCount++;

    const toolsUsed: string[] = [];
    let streamedText = "";

    const result: EngineResult = await this.engine.run(message, {
      sessionId: this.sessionId ?? undefined,
      onStream: async (event: StreamEvent) => {
        // 流式输出 — 你的服务通过 WebSocket 推给前端
        if (event.type === "text_delta") {
          process.stdout.write(event.text);
          streamedText += event.text;
        }
        if (event.type === "tool_use_start") {
          toolsUsed.push(event.toolCall.toolName);
          process.stdout.write(`\n  🔧 ${event.toolCall.toolName}\n`);
        }
        if (event.type === "tool_result") {
          const preview = (event.result.result ?? "").slice(0, 80);
          process.stdout.write(`  ✓ ${preview}...\n`);
        }
      },
    });

    this.sessionId = result.sessionId;

    return {
      reply: result.text,
      sessionId: result.sessionId,
      turn: this.turnCount,
      toolsUsed,
      tokensUsed: result.usage?.totalTokens ?? 0,
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

// ─── 模拟多轮对话 ─────────────────────────────────────────────

async function main() {
  console.log(`
╔════════════════════════════════════════════════════╗
║  PRD Writer Agent — Multi-turn Chat Demo           ║
║                                                    ║
║  这个服务等价于你的后端 API:                        ║
║    POST /api/chat → Engine.run(msg, {sessionId})   ║
║                                                    ║
║  同一个 Engine 内核，CLI/桌面端/Web 共享。           ║
╚════════════════════════════════════════════════════╝
`);

  const chat = new ChatService(engineConfig);

  // ── 预设的多轮对话 ─────────────────────────────────────────

  const conversations = [
    // 第 1 轮：用户描述产品想法
    "我想做一个面向独立开发者的 SaaS 订阅管理工具，帮助他们管理用户付费、处理 Stripe 回调、自动发续费提醒。",

    // 第 2 轮：回答 Agent 的追问（目标用户细节）
    "目标用户是月收入 1000-50000 美元的独立开发者和小型 SaaS 团队。核心痛点是他们现在用 Stripe Dashboard 手动管理，没有统一的订阅视图，也不知道哪些用户快到期了。",

    // 第 3 轮：回答技术偏好
    "技术栈不限，但希望部署简单，最好是一个 Docker 镜像搞定。需要支持 Stripe 和 LemonSqueezy 两个支付平台。",

    // 第 4 轮：让 Agent 开始生成
    "信息差不多了，帮我做个竞品调研然后生成 PRD 吧。",
  ];

  for (let i = 0; i < conversations.length; i++) {
    const userMsg = conversations[i];

    console.log(`\n${"─".repeat(60)}`);
    console.log(`👤 [Turn ${i + 1}] ${userMsg}`);
    console.log(`${"─".repeat(60)}`);
    console.log();

    const response = await chat.send(userMsg);

    console.log(`\n\n📊 Turn ${response.turn} | Session: ${response.sessionId.slice(0, 12)}... | Tokens: ${response.tokensUsed}`);
    if (response.toolsUsed.length > 0) {
      console.log(`🔧 Tools: ${response.toolsUsed.join(", ")}`);
    }
  }

  // ── 可选：进入交互模式继续对话 ─────────────────────────────

  if (process.argv.includes("--interactive")) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = () => {
      rl.question("\n👤 You: ", async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === "/quit") {
          console.log("\nBye!");
          rl.close();
          return;
        }

        console.log();
        const response = await chat.send(trimmed);
        console.log(`\n📊 Turn ${response.turn} | Tokens: ${response.tokensUsed}`);
        if (response.toolsUsed.length > 0) {
          console.log(`🔧 Tools: ${response.toolsUsed.join(", ")}`);
        }

        ask();
      });
    };

    console.log("\n\n── Interactive mode ── (type /quit to exit)");
    ask();
  } else {
    console.log(`\n${"═".repeat(60)}`);
    console.log("Demo 完成。加 --interactive 参数可以继续自由对话：");
    console.log("  bun examples/prd-agent/src/chat.ts --interactive");
    console.log(`${"═".repeat(60)}`);
  }
}

main().catch(console.error);
