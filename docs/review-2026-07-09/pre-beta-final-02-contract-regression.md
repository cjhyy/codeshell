# Pre-beta Final · 02 契约/回归（46 未 push commit）

> codex 独立只读，主编排代为落盘。范围：origin/main..HEAD 净改动。

## 结论：HOLD

Blocker 1 · Major 1 · Minor 1 · Nit 1。

## ToolResult 新契约是否误伤普通工具：**没有（确证）**
- `tool-result-redaction.ts:5` 非敏感直接返回 `result.result`；`:15` 非敏感 `toolResultForDisplay` 返回原对象。
- `turn-loop.ts:1071` 模型侧仍用原始 `toolResultToBlock(result)`；stream/transcript 走 redaction helper；普通工具保持原 result+contentBlocks。
- `executor.ts:490` hooks/recorder 读 `toolResultDisplayText`，普通工具等价旧 `result.result`。
- 风险仅测试覆盖：缺"普通工具无 displayResult 时 stream/transcript/summary/recorder 全保持 result"的直接回归断言（见 Minor）。

## Blocker
### B1 结构化图片附件在非视觉模型下被静默降级，绕过 vision 拒绝（阻塞 rc）
- 证据：`engine.ts:1052` 用 `includeImageBytes: cap.supportsVision` 构建附件；非视觉模型下 `input-attachments.ts:108` 只塞 `<attached-file>` metadata、`images=[]`；`engine.ts:1073` 把 hasImages 置 false → `:1079` 非视觉拒绝分支不触发。新测试 `input-attachments.test.ts:139` 把该行为固化为期望。
- 影响：用户以为发了图，模型实际只看到文件名/大小 → 输入契约回归。
- 建议：保留"非视觉不读 bytes"，但 Engine 层把结构化图片计入 hasImages 并返回 `image_error`，或 attachment context 暴露 `hasStructuredImageAttachments` 给 vision gate。补 Engine 级测试：结构化 image + 非视觉 → reason==="image_error" 且不调 LLM。

## Major
### M1 legacy `<codeshell-image>` 与结构化图片同时存在时，结构化替换 legacy 图片数组
- 证据：`engine.ts:1069` 在 `attachmentContext.images.length>0` 时直接用它、丢弃 `parsedTask.images`。desktop 正常路径不混用，但协议仍支持 legacy image block，外部/迁移期客户端可能同传。
- 建议：合并 `images:[...parsedTask.images, ...attachmentContext.images]`，`hasImages: parsedTask.hasImages || attachmentContext.images.length>0 || hasStructuredImageAttachments`。与 B1 同批修。

## Minor
- 普通 ToolResult 兼容性靠代码审查确认，缺直接契约测试。建议补：非敏感 ToolResult 无 displayResult/transcriptResult 时 LLM history/stream/transcript/summary/recorder 均见原 result。

## Nit
- `executor.ts:529` post_tool_use 的 additionalContext 只追加到 `result.result`；敏感工具若已有 displayResult/transcriptResult，用户可见 transcript/stream 不体现追加 context（不泄密、模型侧可见，仅观测面不一致）。

## 已确认 OK
- core↔desktop stream 主链路无契约错位：agent:streamEvent / seq cursor / snapshot replay / hydrate / coalescer 相关测试通过（115 pass）。
- preload/renderer 无 runtime-import core（type-only）；core 无 import tui。
- browser bucket / credential snapshot / agent-run metadata / attachment 落盘 无互相覆盖或串 session 的确证问题；bridge credential 消息不转发 renderer transcript/stream。

## 验证
- ToolResult 相关 7 pass；附件/vision 测试因只读沙箱 mkdtemp EPERM 未完整跑。
- desktop stream 组 115 pass 0 fail；root+desktop typecheck 通过；import 约束抽查 OK。
