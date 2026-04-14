/**
 * PRD Agent — 程序化入口（你的后端服务直接 import 用）
 *
 * 等价于你在 Express/Fastify/Hono 里写：
 *
 *   const chat = new ChatService(config);
 *   app.post("/api/chat", async (req, res) => {
 *     const result = await chat.send(req.body.message);
 *     res.json(result);
 *   });
 *
 * 运行: bun examples/prd-agent/src/main.ts
 */
import { Engine, type EngineConfig, type StreamEvent } from "../../../src/index.js";
import { prdTools } from "./tools.js";

// ─── ChatService：可直接嵌入你的后端 ────────────────────────────

export class ChatService {
  private engine: Engine;
  private sessionId: string | null = null;
  private turnCount = 0;

  constructor(config: EngineConfig) {
    this.engine = new Engine(config);
    for (const tool of prdTools) {
      this.engine.registerCustomTool(tool.definition, tool.execute);
    }
  }

  async send(message: string, onToken?: (text: string) => void) {
    this.turnCount++;
    const toolsUsed: string[] = [];

    const result = await this.engine.run(message, {
      sessionId: this.sessionId ?? undefined,
      onStream: async (event: StreamEvent) => {
        if (event.type === "text_delta" && onToken) {
          onToken(event.text);
        }
        if (event.type === "tool_use_start") {
          toolsUsed.push(event.toolCall.toolName);
        }
      },
    });

    this.sessionId = result.sessionId;

    return {
      reply: result.text,
      sessionId: result.sessionId,
      turn: this.turnCount,
      toolsUsed,
      tokens: result.usage?.totalTokens ?? 0,
    };
  }
}

// ─── Demo：模拟 4 轮后端 API 调用 ──────────────────────────────

const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("请设置 OPENAI_API_KEY 或 OPENROUTER_API_KEY");
  process.exit(1);
}

const chat = new ChatService({
  llm: {
    provider: "openai",
    model: process.env.MODEL ?? "gpt-4o-mini",
    apiKey,
    baseUrl: process.env.OPENROUTER_API_KEY
      ? "https://openrouter.ai/api/v1"
      : undefined,
    enableStreaming: true,
  },
  maxTurns: 30,
  permissionMode: "bypassPermissions",
  preset: "general",
  customSystemPrompt: `You are a PRD writer. Help users create product requirement documents in Chinese.
Available tools: LoadTemplate (read PRD template), SavePRD (save output), CompetitorResearch (market research).
Be conversational. Ask one question at a time.`,
});

// 模拟 4 次 HTTP 请求
const requests = [
  { message: "我想做一个 AI 驱动的日报周报生成工具，面向 10-100 人的研发团队。" },
  { message: "核心痛点是工程师讨厌写周报，但 leader 需要了解进度。我们从 Git commit 和 Jira ticket 自动生成。" },
  { message: "先支持 GitHub + Jira，后续加 GitLab + Linear。技术栈用 Node.js + React。" },
  { message: "好，帮我调研一下竞品，然后生成 PRD。" },
];

console.log("=== Simulating 4 backend API calls ===\n");

for (const [i, req] of requests.entries()) {
  console.log(`\n>>> POST /api/chat  [Turn ${i + 1}]`);
  console.log(`>>> Body: ${JSON.stringify(req)}\n`);

  const res = await chat.send(req.message, (token) => {
    process.stdout.write(token);
  });

  console.log(`\n\n<<< 200 OK`);
  console.log(`<<< { turn: ${res.turn}, tokens: ${res.tokens}, tools: [${res.toolsUsed.join(", ")}], session: "${res.sessionId.slice(0, 12)}..." }\n`);
  console.log("─".repeat(60));
}
