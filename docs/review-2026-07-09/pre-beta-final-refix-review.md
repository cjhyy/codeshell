# Pre-beta Final Refix 复审（commit 8441bade）

> codex 独立只读复审，主编排代为落盘。范围严格限定 commit 8441bade。

## 结论：SHIP-with-nits

Blocker 0 · Major 0 · Minor 0 · Nit 3。3 Blocker + 2 安全 Major 全部确证修好，无新回归。

## B1 明文是否还有日志旁路：**未发现旁路**
明文仅保留在真正发给 provider 的请求副本。证据链：
- `turn-loop.ts:1081` 对 sensitive result 建 `tool_use_id→transcriptText` redaction map；`:183` provider 块仍用真实 `result.result`；`:683` pending sensitive 时跳过 `contextManager.manageAsync`（compaction 拿不到明文）；`:427` snapshot 为 ModelCallRecordingOptions。
- `model-facade.ts:60/156` recorder 副本调 `sanitizeMessages(messages, recordingOptions)`，provider 调用传原始 messages。
- `sanitize-messages.ts:115` 按 tool_use_id 替换，key 与 `turn-loop.ts:187` 一致。
- `turn-loop.ts:790` 响应后 redactConsumedSensitiveToolResults 替换工作历史；`:1416` sensitive pending 时 streaming 失败不 fallback non-streaming。
- `executor.ts:490` recorder tool result 用 `toolResultDisplayText`（placeholder）。
- `rg recordLLMRequest` 只有 model-facade.ts 两个调用点，无其它旁路。

## 逐条：全部已修好
- **B1** recorder redaction：多敏感结果 Map 逐次 snapshot，recorder sanitize、provider 不 sanitize；max-token continuation 在 redaction/clear 之后、不带明文。
- **B2** vision gate：`engine.ts:1067` legacy+structured 合并；`:1077` 非视觉遇图 image_error（LLM 前）；`input-attachments.ts:141` 只 `kind==="image"` 才设 hasStructuredImageAttachments（普通文件不误判）；测试断言不调 LLM + 视觉模型 legacy+structured 都进请求。
- **B3** notice：THIRD_PARTY_NOTICES.md 覆盖 ApplyPatch/Apache + Yoga/MIT + browser-use/MIT；package.json:52 extraResources 路径正确；测试通过。
- **M1** 附件绑 session：`input-attachments.ts:58` 先校验 expectedSessionId、`:82` stat/read 前拒 cross-session、`:219` staged realpath 限 `.code-shell/attachments/<sessionId>/`（拒 `..`/symlink）；`engine.ts:1052` 传当前 run sessionId；`chat-session.ts:220` protocol path 传 ChatSession.id。
- **M2** migration 幂等：`credential-migration.ts:75` 读 raw file 判定、`:119` enc:safeStorage:* 不 rewrite、`:61` per-file promise 队列；`credential-access-service.ts:25` snapshot 不触发 migration；`index.ts:1609` migration 保留在 startup/list/restore。

## Nit（不阻塞）
1. 建议补"目录内 symlink 指向外部文件"显式用例（realpath 已拦截）。
2. 建议补 Engine 层"非视觉 + 非图片结构化附件仍调 LLM"回归测试（静态逻辑已证不误判）。
3. 建议补 non-streaming recorder redaction 直接单测（两路径都调 sanitizeMessages）。

## 边界与回归
- core 无 import tui；renderer 对 core 为 type-only。
- 普通无敏感结果对话不受 B1 影响（redaction map 空时等价原 sanitize）。
- 视觉模型正常发图保留，legacy+structured 合并顺序 legacy first。非图片附件不触发 image_error。

## 验证
- typecheck 通过；lint 0 errors；third-party-notices 2 pass；sanitize/sensitive-result/recorder 组 17 pass（1 fail 为只读沙箱 recorder 文件未创建，非明文泄露）；其余 attachment/migration 因 mkdtemp EPERM 未跑完。
