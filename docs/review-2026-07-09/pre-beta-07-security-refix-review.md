# Pre-beta 07 · 安全修复第二轮复审（commit a472c6f3）

> codex 独立只读复审，主编排代为落盘。审查范围严格限定 commit a472c6f3。

## 结论：REQUEST-CHANGES

Blocker 1 · Major 0 · Minor 1。B1 未彻底修好：正常路径已修，但几个终态分支漏 redaction，明文可留内存 history → Engine 缓存 → resume 复用 → 再进模型调用。

## B1 明文是否还有泄露路径：**有，已确证**

正常路径下 UseCredential token/link 的 stream/transcript/tool_summary/hook/dev-recorder 已改占位符（确认修好）；但敏感 tool result 进入 `messages` 后，若走部分终态/边界分支，内存 history 没被替换成占位符。

### Blocker B1-残留：终态分支漏 redaction（阻塞 beta）
- 明文入口：`turn-loop.ts:1067` `toolResultToBlock(result)` 把敏感明文放进 resultBlocks，`:1115` 放入 messages。
- 漏网分支：
  - `turn-loop.ts:593` loop 顶部 abort fast-path 直接 return，无 redaction。
  - `turn-loop.ts:1175` `cancel_goal(confirm:true)` 直接 return，无 redaction（对比 `:1163` complete_goal 有 redaction）。
  - `turn-loop.ts:1295` max-turns final summary 前仍对 pending sensitive history 跑 `contextManager.manage()`，绕过 `:674` 的"pending sensitive 时跳过 context management"防线。
- 后果：Engine 把返回的 `result.messages` 存内存缓存（`engine.ts:2305`），下次同进程 resume 优先用该缓存（`engine.ts:1449`）→ 明文再进后续模型调用；manual compact 也可能基于该缓存处理明文。
- 建议：把 redaction 做成所有 return 前的统一出口（finally），至少补齐 abort fast-path / cancel_goal / max-turns 三分支；max-turns 分支在 pending sensitive 时也应跳过 context management，直到明文完成唯一一次模型消费并 redacted。

### 已确认修好的 B1 子路径
transcript→`toolResultTranscriptText`、stream→`toolResultForDisplay`、tool_summary→`toolResultsForDisplay`、executor hook/dev recorder→`toolResultDisplayText`；非敏感工具默认回退 `result`，未误伤普通工具显示/持久化。

### 边界
多敏感结果正常路径用 Map 按 tool id 替换，逻辑支持但无测试。sub-agent/DriveAgent 无额外明文传播路径，但 sub-agent 内部仍受同一 TurnLoop 终态漏洞影响。

## M1/M2/M3：均已修好
- M1：desktop snapshot/env、worker resolve/materialize、MCP probe/header 都过 `isCredentialSecretAvailable()` fail-closed，未见 enc:* 被当 env/header/materialize。
- M2：webview attach main 权威 pending guest，renderer metadata 必须匹配 owner window/guestId/partition；renderer 不能建/rebind session bucket。
- M3：renderer IPC 与 injectWorkerMessage 共用 prepareAgentRunMetadata/handleAgentRunMetadata；InjectCredential cwd 用 session map 或 persisted cwd，去掉 lastRunContext 兜底。

## Minor
### m1 测试缺终态覆盖（解释了漏网）
现有 `turn-loop-sensitive-result.test.ts` 只覆盖"敏感结果后下一轮正常 stop"；未覆盖 abort fast-path / cancel_goal 同批 / max-turns final summary / 多敏感结果 / manual+auto compaction pending sensitive。建议补，并断言 secret 不在 returned history、cached history、summary prompt、tool-result persistence 输入中。

## 验证
- typecheck 通过；sensitive-result / agent-run-metadata / active-guest 测试 pass；credential/mcp 测试因只读沙箱 mkdtemp EPERM 未跑完（非断言失败）。
