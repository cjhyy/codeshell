# Pre-beta Final · 01 安全/正确性（46 未 push commit）

> codex 独立只读，主编排代为落盘。范围：origin/main..HEAD（257 files, +25974/-1747）。

## 结论：HOLD

Blocker 1 · Major 2。

## 凭证明文是否彻底安全：**否**（新增 dev recorder 泄露路径）

transcript/stream/renderer/resume 主路径已 redact 到位；但 `UseCredential` 敏感 result 在下一次模型调用前会进 dev verbose LLM request recorder，真实 token/link 写入 `log/<date>/engine/session-*.jsonl`。

## Blocker
### B1 UseCredential 明文进 dev verbose LLM request 日志（阻塞 rc）
- 证据：token/link 在 `use-credential-tool.ts:182` 返回真实 value，`:242` 才包装 sensitive display/transcript。TurnLoop `turn-loop.ts:1072` 把原始明文 tool result 放进下轮 model-facing messages，`:783` 模型调用后才替换历史。ModelFacade 在调用前记录 `sanitizeMessages(messages)`（`model-facade.ts:55/150`），而 `sanitize-messages.ts:123` 只处理图片块、非图片 tool result 原样保留。session recorder 在 dev/debug 下写 messages（`session-recorder.ts:53/237`）。
- 影响：dev/debug 下用真实凭证跑，明文 token/link 落 `log/.../session-*.jsonl`。
- 建议：provider 仍拿原始 messages，但 recorder 拿 redacted 副本——TurnLoop 调 ModelFacade 时传 `messagesForRecording`（用 `sensitiveToolResultRedactions` 先替换 tool_result），或让 recorder/sanitizer 识别 sensitive tool_use_id。补测试断言 recordLLMRequest 不含真实凭证。
- 临时规避：rc 自测别用真实凭证跑 `bun run dev`/`--debug`。

## Major
### M1 core 读附件前未校验 attachment 属于当前 session（建议阻塞附件功能）
- 证据：`engine.ts:1052` 调用只传 attachments/cwd 不传 expected sessionId；`input-attachments.ts:56/75` 直接解析 metadata 路径并按 path-policy 放行读字节（`:147`）；sessionId 只带进结果 metadata（`:167`）。desktop `markAttachmentsSent` 跳过 mismatch（`attachment-service.ts:185`）是发送后 manifest 语义、非读取前授权。
- 建议：`buildInputAttachmentContext` 接 expected session id，读取前拒 `attachment.sessionId !== expected`；staged attachment 再校验 realpath 在 `.code-shell/attachments/<expectedSessionId>/` 下。

### M2 credential migration/snapshot 写路径非幂等，放大 credentials.json 并发/陈旧覆盖
- 证据：snapshot 每次构建 entry 都调 migration（`credential-access-service.ts:63`）；UI list 也调（`index.ts:1790`）；migration 先 list 快照再逐条 save（`credential-migration.ts:39/45`），`shouldRewriteCredential` 对所有可读 secret 返回 true（`:53`）；底层 save/patch/remove 整文件读改写（`store.ts:113`）。
- 建议：migration 只 rewrite legacy bare/plain 或需换 cipher 的项，不每次 list/snapshot 重写已加密项；按 file path 进程内队列 + 跨进程文件锁或 CAS/retry。

## 未发现净新增问题（正向）
- browser registry：registerSessionBucket 绑 session→bucket，active/list/focus 按 session 取 bucket（`active-guest.ts:95`、`agent-bridge.ts:457`），M3 未回退。
- InjectCredential：按 parsed.sessionId 查 bucket/cwd/partition，失败关闭（`agent-bridge.ts:588`）。
- skills:uninstall：只删已列出一级 skill 目录、拒 symlink（`skills-service.ts:86/148`）。

## 验证
- typecheck 通过；sensitive-result + browser active-guest + tunnel + streaming-fallback + max-turns 相关用例通过；其余因只读沙箱 mkdtemp EPERM 未跑完。

## 最需关注
1. 先修 B1；rc 自测别用真实凭证跑 dev/debug。
2. 附件读取前绑定 session。
3. credential migration 幂等 + 序列化。
