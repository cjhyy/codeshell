# PRD Agent

基于 CodeShell Engine 的 PRD 生成 Agent 示例。

演示如何把 CodeShell 当 SDK 集成到你自己的后端服务，通过多轮对话驱动 Agent 生成 PRD 文档。

## 核心原理

```
Engine（多轮对话 + 工具调用 + session 持久化）
  ↑
  │ 同一套 engine.run(message, {sessionId})
  │
  ├── CLI TUI (Ink)           ← CodeShell 自带
  ├── 你的后端服务 (main.ts)   ← 这个示例
  ├── Mac 桌面端 (Electron)    ← 同样的 ChatService
  └── Web 前端 (WebSocket)     ← 同样的 ChatService
```

所有端共享同一个 Engine 内核，区别只在 I/O 形态。

## 项目结构

```
prd-agent/
├── src/
│   ├── product.ts      # 产品定义（preset + adapter + contract）
│   ├── tools.ts         # 自定义工具：LoadTemplate, SavePRD, CompetitorResearch
│   ├── evaluator.ts     # PRD 质量评估器
│   ├── chat.ts          # 多轮对话 demo（4 轮预设 + 可选交互模式）
│   └── main.ts          # 程序化入口（模拟后端 API 调用）
├── templates/
│   └── prd-template.md
├── output/              # 生成的 PRD 存放
└── package.json
```

## 运行

```bash
export OPENAI_API_KEY=sk-xxx

# 方式 1：预设 4 轮对话 demo
bun examples/prd-agent/src/chat.ts

# 方式 1b：预设对话后进入交互模式继续聊
bun examples/prd-agent/src/chat.ts --interactive

# 方式 2：模拟后端 API 调用
bun examples/prd-agent/src/main.ts
```

## 后端集成

```ts
import { ChatService } from "./src/main.js";

// 每个用户一个 ChatService 实例
const chat = new ChatService(engineConfig);

// Express/Fastify/Hono 路由
app.post("/api/chat", async (req, res) => {
  const result = await chat.send(req.body.message, (token) => {
    // 流式推送到 WebSocket
    ws.send(JSON.stringify({ type: "token", text: token }));
  });
  res.json(result);
});
```

## 对话流程

```
Turn 1: 用户描述产品想法
Turn 2: Agent 追问目标用户和痛点 → 用户回答
Turn 3: Agent 追问技术偏好 → 用户回答
Turn 4: 用户说"生成PRD" → Agent 调用 CompetitorResearch → LoadTemplate → SavePRD
```

每一轮都走 `engine.run(message, { sessionId })` —— session 自动持久化，重启进程也能续接。
