# 冒烟自动化 — 本地 mock provider server

> 状态:**设计已定稿并提交 main**(spec `docs/superpowers/specs/2026-07-02-smoke-automation-mock-provider-design.md`),未动手实现。2026-07-02。
> 背景:第一个测试版本已发,当前靠手动真机冒烟。目标把稳定性价比最高的 80% 自动化。
> 完整设计见 spec;本文是 todo 目录的登记 + 摘要,便于排期。

## 目标(v1 范围)

- **应用能起来 + UI 接线**:Electron 启动、四面板/设置页/会话打开、按钮有反应、不白屏不崩。
- **LLM 全链路**:真发一条消息 → 流式回显 → 工具卡渲染 → usage/缓存区域显示。
- **不在 v1**:外部集成(浏览器 CDP / CC / Codex / MCP / cron)。先真机手测,稳了逐个加。

## 核心思路

起一个本地 HTTP server 讲 provider wire 协议,把 app 的 provider 配置指到 `http://localhost:PORT`。
App 发**真实** HTTP 请求,server 返回脚本化 SSE(文本/工具调用/usage)。**零 core 改动**——
`baseUrl` 已全接线(`openai.ts:222` / `anthropic.ts:52`,解析 `resolve.ts:50,68`,config 接受任意字符串)。

## 分层(便宜的先做)

- **L1 启动+UI**:Playwright 驱动真实 Electron,扩展现有 `packages/desktop/scripts/smoke-panels.mjs`。
- **L2 LLM 全链路**:mock server + 隔离 `CODE_SHELL_HOME` 下临时 catalog 指向 localhost;发消息断言 DOM。
- **L3 发布产物**:后续,不在 v1。

## Mock server 要点

- 一进程两路由:`/v1/chat/completions`(OpenAI,**v1 先完整做**)+ `/v1/messages`(Anthropic,fast-follow)。
- 场景选择:请求头 `x-mock-scenario`:`plain-text` / `tool-call` / `usage-with-cache` / `error-then-ok`(验 retry)。
- ⚠️ Anthropic 路由要 emit **原始 SSE 事件序列**(message_start→content_block_*→message_delta→message_stop),
  SDK 才能解析成 `.on("text")`/`finalMessage()`;比 OpenAI 格式finicky,故排后。
- 隔离:测试脚本 spawn server → 隔离 HOME 写临时 catalog → 跑 → 拆,**绝不碰真实 settings**(参照 `test_pollutes_real_settings`,写盘必 `userHome()`)。

## 断言粒度 & 运行

- **关键链路存在性**(粗粒度):assistant 块出现 / 工具卡出现 / usage 区非空;不做文本精确匹配(UI 文案一改就碎)。
- **先只本地命令**:`bun run smoke` 一键(启 server→启 Electron→跑 L1+L2→拆);先不接 CI(headless Electron 坑多)。

## v1 交付清单

1. mock server,OpenAI 路由完整(4 scenario)。
2. smoke harness:隔离 HOME + 临时 catalog + spawn/teardown(finally 保拆,不留孤儿进程/临时 HOME)。
3. L1 断言(复用/扩展面板冒烟)。
4. L2 断言(发消息→assistant 块 / 工具卡 / usage 存在性)。
5. `bun run smoke` 入口。
6. Anthropic 路由(fast-follow,同 server 加路由)。

## 未决 / 后续

- L3 打包产物冒烟;外部集成假件(逐个);CI 接入(headless Electron)。
