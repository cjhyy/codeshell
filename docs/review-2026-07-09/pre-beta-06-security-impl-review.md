# Pre-beta 06 · 安全实现复审（commit f9d68129）

> codex 独立只读复审，主编排代为落盘。审查范围严格限定 commit f9d68129（M3+M2+desktop M1/M4/M5）。

## 结论：REQUEST-CHANGES

Blocker 1 · Major 3 · Minor 1 · Nit 1。

## 明文是否会泄露：**会泄露，已确证**

`UseCredential` 的 token/link 成功结果把明文放进普通 `ToolResult.result`（`use-credential-tool.ts:175-183`）→ TurnLoop 原样写 transcript + 发 stream event（`turn-loop.ts:1030-1044`、`transcript.ts:89-102/235-237`）→ AgentBridge 发给 renderer（`agent-bridge.ts:250-261`）→ 且 ToolExecutor dev recorder / hook payload 也拿到同一明文（`executor.ts:498-520`）。

正向点：`desktop/credentialResolve`/`credentialMaterializeCookie` 在 bridge stdout 入口最先消费、不转发 renderer/transcript（`agent-bridge.ts:224-235/535-585`）；cookie materialize 只返回 `{cookiesFile,count}`、临时文件随机名 0o600（`access.ts:232-243`）。

## Blocker

### B1 UseCredential token/link 明文进 transcript/stream/renderer/日志/hook（阻塞 beta）
证据：`use-credential-tool.ts:181-182`（plaintext value JSON 化进 result）→ `turn-loop.ts:1035-1044`（持久化+stream）→ `transcript.ts:96-101/235-237` → `agent-bridge.ts:256-261`（发 renderer）→ `executor.ts:498-520`（dev recorder + hook）。
建议：给 ToolResult 加敏感语义，拆 `resultForModel`/`resultForDisplay`/`resultForTranscript`；token/link 的显示与持久化必须占位符；明文只进当前 LLM message，不写 transcript/stream/renderer/log/hook；resume 不从磁盘恢复明文。

## Major

### M1 enc:safeStorage:* 不可解时仍可能被当 env/header 使用（阻塞 beta）
证据：safeStorage 不可用时 `canDecrypt()` 对 `enc:*` 返回 false（`credential-cipher.ts:46-49`），`decryptSecret()` 保留原始密文（`store.ts:64-70`）；desktop snapshot 用 `store.envExposures()` 生成 env（`credential-access-service.ts:63-72`），而 `envExposures()` 只判非空、不排除 `enc:`（`store.ts:188-193`）→ 密文进 worker snapshot / shell env。同类：MCP probe 直接 `credStore.resolve(id)?.secret`（`mcp-probe-service.ts:179-184`）→ 拼进 Authorization（`mcp-manager.ts:105-112`）。
建议：所有 env/header/materialize/value callsite 统一过 `isCredentialSecretAvailable()`；credential-access-service 本地过滤不调旧 envExposures；MCP probe 改用带 credential-access 的 header 构建或拒绝 unavailable。补 fail-closed 测试。

### M2 Browser registry 信任 renderer 可伪造的 bucket/guest 注册（安全 beta 建议阻塞）
证据：preload 暴露任意 payload 注册 API（`preload/index.ts:1116-1126`）；main 接受 `browser:register-session-bucket` 直接注册（`index.ts:1830-1839`）；`browser:guest-attached` 仅用 renderer 提供的 guestId/bucket/partition（`index.ts:1845-1873`）；registry 只校验 partition 字符串（`active-guest.ts:70-79/96-99/270-277`），不验 guest 真属发送窗口。
影响：正常路径 M3 已 fail-closed，但 renderer 被 XSS/供应链执行时可重绑 sessionId→bucket 或把别的 guestId 注册到当前 bucket，重制跨 session 串台。
建议：main 在 did-attach-webview 建 pending 记录绑定 sender window→guestId→actual partition，renderer 只补 metadata，main 验证 owner+partition 后才注册；sessionId→bucket 以 agent/run main-only routing 或 main 生成 nonce 为准。

### M3 injectWorkerMessage 未复用 agent/run 安全元数据处理，移动端/自动化续跑丢 snapshot/bucket
证据：renderer path 对 agent/run 会 register bucket + 记 sessionCwd + strip main-only + pushCredentialSnapshot（`agent-bridge.ts:365-397`）；但 `injectWorkerMessage()` 的 agent/run path 只 spawn+记 cwd（`:763-789`）；InjectCredential 找不到 sessionCwd 时 fallback `lastRunContext.cwd`（`:615-617`）可能取错项目凭证。
建议：抽共享函数两入口都跑（register bucket/cwd/snapshot/strip）；cwd 缺失从 SessionManager 按 sessionId 读，读不到 fail-closed，不用 lastRunContext 兜底解析凭证。

## Minor
### m1 安全测试缺关键负向断言
缺：UseCredential 成功 token 不进 stream/transcript/renderer；desktop snapshot 对 unreadable enc:* 的 env fail-closed；renderer 伪造 guestId/sessionId/bucket 被拒。建议补为安全回归测试。

## Nit
### n1 `use-credential-tool.ts:10` 注释仍写"无跨进程"，实际已走 IPC resolver，应更新。

## 其他核对（正向）
- local/headless 普通取值对 foreign enc:* 基本 fail-closed（`access.ts:176-229`）
- cookie 临时文件随机名 0o600 + 30min stale sweep（`access.ts:232-254`）
- legacy plain→enc 迁移走 save() tmp+rename，main 同步无并发 interleave（`credential-migration.ts:39-56`）
- M3 正常路径缺 sessionId/bucket fail-closed、list/switch_tab bucket 约束、InjectCredential 无 guest 写 partitionForSession ✓
- M1 image-read realpath 约束 workspace roots、无 context 返回 null ✓
- M4 skills:uninstall 新 contract + realpath/direct-child/symlink 校验 ✓
- ESLint guardrails 无新违规 ✓

## 验证
- typecheck 通过；lint exit 0（133 既有 warning）；access.test 1 pass；active-guest.test 4 pass；部分测试因只读沙箱 mkdtemp EPERM 未跑完（非断言失败）。
