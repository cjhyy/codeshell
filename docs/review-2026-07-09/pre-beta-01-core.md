# Pre-beta 全 repo 体检 · 01 core 引擎

> 范围：只审 `packages/core/src`（engine / tool-system / protocol / session / memory / preset）。
> 审查方式：codex 独立只读会话（read-only 沙箱），本文件由主编排 agent 代为落盘。
> 基线 HEAD `ccef4283`。

## 结论：SHIP-with-nits

Blocker 0 · Major 3 · Minor 2 · Nit 1。无必须卡 beta 的 Blocker。

## Major

### M1 transcript replay 丢失 errored tool_result 的 wire-level 错误标志（确证）
- 证据：`ContentBlock.is_error` 用于让 provider 设置 Anthropic `is_error:true`（`types.ts:17`）；live path 在 `toolResultToBlock()` 设置（`turn-loop.ts:177`）；但 transcript 落盘只存 `result/error/contentBlocks`，不存 `isError/is_error`（`transcript.ts:89`）；replay 时即使有 `error` 也只拼 `"Error: ..."`、未设 `is_error`（`transcript.ts:171`）；Anthropic provider 只在 block 有 `is_error` 时转发（`anthropic.ts:412`）。
- 影响：resume 会话或修复缺失 tool result 后，模型/Anthropic wire contract 可能把失败工具结果当普通成功文本处理，影响 resume 后正确性。
- 建议：`appendToolResult` 持久化 `isError`；`loadMessages()` 在 `error` 或标志存在时设 `block.is_error=true`；补 transcript roundtrip 回归测试。
- 阻塞 beta：不阻塞，但建议发前修（改动小、契约明确）。

### M2 ChatSessionManager.close() 不 drain pendingApprovals，清理职责分裂（确证）
- 证据：`ChatSession` 持 per-session `pendingApprovals`（`chat-session.ts:53`）；`cancel()` 只 abort + drain queued turns，不处理 pending approvals（`chat-session.ts:121`）；`ChatSessionManager.close()` 调 `cancel()` 后清 cache + delete session，但不 resolve pending approvals（`chat-session-manager.ts:111`）；额外的 `cancelSessionApprovals()` 在 `AgentServer` 层（`server.ts:810/1055/2432`）。
- 影响：server 主入口已补上；但 lower-level manager API 直接 close 时 AskUser/browser/tool approval promise 可能悬挂，且增加未来调用方遗漏清理的概率。
- 建议：把 pending approval resolve 下沉到 `ChatSession`/`ChatSessionManager.close()`，AgentServer 只管 approval timers；补 direct `close()` 回归测试。
- 阻塞 beta：public beta 只暴露 AgentServer close/cancel → 不阻塞；若 core manager 被 embedder 直接用 → 建议发前修。

### M3 path policy check 与实际文件 I/O 间的 TOCTOU 窗口（推测/设计风险）
- 证据：executor 统一 enforce declared path policy（`executor.ts:320`），分类依赖 `safeRealpath()` 最近存在祖先（`path-policy.ts:375`）；随后 handler 自己重新 resolve raw path 执行 I/O：Read `stat/readFile`（`read.ts:53`）、Write `mkdir/writeFile`（`write.ts:34`）、Edit `readFile/writeFile`（`edit.ts:55`）。
- 影响：恶意本地进程/仓库脚本若能在 check 与 I/O 间替换父目录或 symlink，理论上可把读写导向已批准路径之外。非远程单步利用，属安全边界硬化点。
- 建议：executor 把 policy-verified resolved path 传给 handler；handler open/write 前复核父目录 realpath；symlink 写入用 `lstat`/`O_NOFOLLOW`；补 race/symlink 回归。
- 阻塞 beta：不阻塞，列为安全 hardening。

## Minor

### m1 project path approval / permission rule 非锁定 read-modify-write，可能并发丢更新（确证）
- 证据：path approvals 读改写 tmp rename（`path-policy.ts:315`）；permission project rules 同样（`permission.ts:562`）。
- 影响：两 session 同时保存项目级授权时后写者覆盖先写者，通常表现为重复询问、非权限放大。
- 建议：加文件锁或写前重读合并。阻塞 beta：否。

### m2 Config tool 写 settings.json 非 atomic（确证）
- 证据：直接 `writeFileSync(configPath, ...)`（`config.ts:83`）。
- 影响：崩溃/断电可留半截项目 settings。建议：沿用 tmp+rename。阻塞 beta：否。

## Nit
- 测试缺口：缺 `Transcript.appendToolResult → loadMessages` 保留错误语义的 roundtrip 测试。

## 正向检查点
- AskUser session 隔离主路径 fail-closed：session-tagged approve 只查对应 session、不 fallback global（`server.ts:727`）✓
- session id 有 basename/字符/长度校验（`session-manager.ts:61/467/499`）✓
- streaming queue 对 rejecting tools 转 synthetic error、不丢其它结果（`streaming-tool-queue.ts:66`）✓
- turn-loop abort 检查 + fire-and-forget summary 有 catch、异常终态返回不挂住（`turn-loop.ts:657/1046/1218`）✓

## 验证命令
- `bun run typecheck`：通过。
- turn-loop / streaming / provider error 测试：17 pass 0 fail。
- protocol / path-policy / session 等测试在只读沙箱下多因 `mkdtemp EPERM` 失败（非断言失败）。
