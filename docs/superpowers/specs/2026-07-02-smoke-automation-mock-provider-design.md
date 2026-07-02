# 冒烟自动化：本地 mock provider server 设计

日期：2026-07-02
状态：设计已批准，待写实现计划

## 背景与目标

第一个测试版本已发布，当前靠手动真机冒烟。目标是把冒烟中**稳定性价比最高的 80%** 自动化：

- **应用能起来 + UI 接线**：Electron 启动、四面板/设置页/会话能打开、按钮点了有反应、不白屏不崩。
- **LLM 全链路**：真的发一条消息 → 流式回显 → 工具卡渲染 → usage/缓存区域显示。

明确**不在 v1 范围**：外部集成（浏览器 CDP / CC / Codex / MCP / cron）。这些跨进程、依赖真实外部二进制，mock 成本高、假件易偏。v1 先靠真机手测覆盖它们，稳定后逐个加。

## 核心思路

不在 core 里加 `if (process.env.MOCK)` 分支。改为**起一个本地 HTTP server，讲 provider 的 wire 协议**，把 app 的 provider 配置指到 `http://localhost:PORT`。App 发**真实** HTTP 请求，server 返回脚本化内容（文本块 / 工具调用 / usage）。下游（真实 HTTP 客户端、SSE 解析、retry、缓存头读取）全被真实驱动。

**为什么可行（已核对代码）：** `baseUrl` 已全接线，无需改 core：
- OpenAI：`packages/core/src/llm/providers/openai.ts:222` 用 `this.config.baseUrl` 实例化 SDK。
- Anthropic：`packages/core/src/llm/providers/anthropic.ts:52` 同理。
- 解析优先级 `connection.baseUrl ?? credential.baseUrl ?? catalog.defaultBaseUrl`（`packages/core/src/model-catalog/resolve.ts:50,68`）。
- config 接受任意字符串；`packages/core/src/llm/retry-abort.test.ts:25` 已用 `http://localhost`。

## 分层策略（便宜的先做）

| 层 | 抓什么 | 机制 |
|---|---|---|
| **L1 — 启动 + UI 接线** | 白屏、面板不挂载、按钮无反应、打开即崩 | Playwright 驱动真实 Electron（扩展现有 `packages/desktop/scripts/smoke-panels.mjs`） |
| **L2 — LLM 全链路** | 发送→流式→渲染、工具卡、usage/缓存显示、4xx retry | mock server + 临时 catalog 指向 `localhost:PORT`；Playwright 发消息断言 DOM |
| **L3 — 发布产物**（后续，不在 v1） | 打包 dmg/exe 能装能起、原生模块在、版本对 | 独立，v1 不做 |

## Mock provider server

### 形态
- 一个独立进程（Node/Bun HTTP server），无外部依赖。
- 两条路由：
  - `/v1/chat/completions`（OpenAI 兼容）—— **v1 先完整做这条**。OpenRouter/GLM/本地多数走此格式，性价比最高、SSE 格式最简单。
  - `/v1/messages`（Anthropic 兼容）—— **fast-follow**。见下方风险说明。
- 复用价值：既是自动冒烟的被测依赖，也能 `bun run mock-provider` 单独手动起，在连接页填 localhost 真机玩。自动冒烟只是它的一个消费者。

### 场景选择
请求头 `x-mock-scenario: <name>`（脚本设置）或 body 里的 model 名选定返回哪段脚本流：
- `plain-text` — 纯文本流式。
- `tool-call` — 一次工具调用。
- `usage-with-cache` — 带 cache_read/cache_write 的 usage。
- `error-then-ok` — 首次返回 4xx，重试后成功（验 retry 链路）。

### 各格式必须 emit 的形状（已核对解析器）

**OpenAI**（`stream:true`，解析器 `openai.ts:557-641`）：
```jsonc
// 文本增量
{ "choices": [{ "delta": { "content": "..." }, "finish_reason": null }] }
// 工具调用（arguments 跨 chunk 累积为 partial JSON）
{ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "...", "function": { "name": "...", "arguments": "{\"a\":" } }] } }] }
// 末尾 chunk 的 usage
{ "choices": [{ "delta": {}, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": N, "completion_tokens": N, "total_tokens": N,
             "prompt_tokens_details": { "cached_tokens": N, "cache_write_tokens": N } } }
```

**Anthropic**（解析器 `anthropic.ts:277-328`，走 SDK 事件模型）：mock server 必须 emit Anthropic **原始 SSE 事件序列**（`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`），真实 SDK 再解析成 `.on("text")` / `.on("contentBlock")` / `finalMessage()`。`finalMessage().usage` 需含 `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`。

### 隔离
测试脚本负责生命周期：spawn server → 在**隔离的 `CODE_SHELL_HOME`**（临时目录）下写一份指向该 server 的 catalog/连接配置 → 跑 → 拆。**绝不碰真实 settings**。参照记忆 `test_pollutes_real_settings`：写盘必用 `userHome()` 且隔离 HOME。

## 断言粒度：关键链路存在性

Playwright 断言粗粒度**存在性**，不做内容精确匹配（UI 文案一改就碎、维护贵）：
- 发完消息后**出现了 assistant 消息块**。
- `tool-call` 场景**工具卡出现**。
- `usage-with-cache` 场景 **usage 区域非空**。
- 不断言回显文本 === mock 发的确切字符串。

## 运行方式：先只本地命令

- `bun run smoke`（在 desktop 包或仓库根）一键：启 mock server → 启 Electron（复用 `CODE_SHELL_NO_DEVTOOLS`）→ 跑 L1+L2 → 拆。
- **先不碰 CI**：Electron+Playwright 在 headless CI（xvfb 等）上坑多，先把本地跑稳。CI 留后续。

## 组件边界

1. **mock-provider server**（新，独立文件/小包）：纯 HTTP + SSE，按 scenario 返回。可独立跑，无 Electron 依赖。输入=请求（含 scenario 头），输出=SSE 字节流。
2. **smoke harness**（扩展 `smoke-panels.mjs` 或新建姊妹脚本）：编排 server 生命周期 + 临时 HOME/catalog + Playwright 驱动 + 断言。依赖 server 与真实 app。
3. **临时 catalog fixture**：一份 JSON，把某个 provider 的 `baseUrl` 指向 `localhost:PORT`。写进隔离 HOME。

## 错误处理

- server spawn 失败 / 端口占用：harness fail-loud，打印端口。
- Electron 抓 `pageerror`（现有 `smoke-panels.mjs` 已有此钩子），任何 renderer 报错记录。
- 拆除保证：finally 里 kill server + close app，即使断言失败也不留孤儿进程/临时 HOME。

## v1 交付清单

1. mock server，OpenAI 路由完整（4 个 scenario）。
2. smoke harness：隔离 HOME + 临时 catalog + spawn/teardown。
3. L1 断言（复用/扩展现有面板冒烟）。
4. L2 断言（发消息→assistant 块 / 工具卡 / usage 存在性）。
5. `bun run smoke` 脚本入口。
6. Anthropic 路由（fast-follow，同一 server 加路由）。

## 未决 / 后续

- L3 打包产物冒烟。
- 外部集成（浏览器/CC/Codex/MCP/cron）假件，逐个加。
- CI 接入（headless Electron）。
