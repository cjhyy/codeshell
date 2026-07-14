# TODO

> 已完成项一律删除（记录在 git 历史与记忆里）。本文件只保留**未完成**的待办。
> 分区规则：**小 feature = 体量 M 及以下（M/S/XS），可单会话直接着手**；**大功能升级 = 体量 L**，需先方案设计再分阶段落地。
> 最近一次核对：2026-07-14（架构债 P1/P2、Arena 移包、App/TUI 拆分、state 单例治理和 Goal V1 持久化已完成并从待办删除）。

---

## 小 feature（体量 M 及以下，现在可直接着手）

> 2026-07-12：上一批 12 项小 feature 已全部落地并合并回 main（未 push）——core 引擎 5 项（goal-judge 上下文重构、prompt-cache 归因、拆 engine.ts、子 agent sandbox/mcp、密钥脱敏硬化）、desktop 2 项（review-panel workspace + fork busy-guard）、跨层 5 项（MCP OAuth 闭环、浏览器复制地址、DriveAgent 跳转、手机发图、命名收敛第一批）、快聊对齐 codex `/side`（修主聊消息串漏）。逐线只读 codex 复审+修复+复核全绿。实施记录见 `docs/todo/small-features-2026-07-10/PIPELINE-SUMMARY-*.md`。

> 本次核对后暂无未完成项。

---

## rc.18 发版遗留（非阻塞项，发 0.7.0 正式版前处理）

> 本次核对后暂无未完成项。

---

## 大功能升级（体量 L，需方案设计 + 分阶段落地）

- **服务端部署 + Web Client + 账号体系**（体量 L，**roadmap/设计稿已出，待实现**）｜设计稿：`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md`｜锚点：`packages/core/src/protocol/server.ts:112`、`packages/core/src/protocol/chat-session-manager.ts:45`、`packages/core/src/cli/agent-server-stdio.ts:203`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:79`、`packages/desktop/src/main/index.ts:827`、`packages/desktop/src/mobile/main.tsx:1`｜现状：只有桌面端 Electron；核心协议已 transport-agnostic（in-process/stdio/TCP）且有 live multi-session 生命周期，但无 identity/tenant——`ChatSessionManager` 只按裸 `sessionId`、`RunParams.cwd` 客户端可提交、session/settings/credentials/memory 默认无 `userId` 维度；远程 HTTP+WS host/配对/passcode/tunnel 全耦在 Electron main 的 `handleMobileClientEvent` + `AgentBridge`；现有鉴权只有 passcode + pairing token + 设备 secretHash，非真账号体系；`agent-server-tcp` 明确无 auth、仅 localhost。**推荐方案 A**：新增 `packages/server` 作鉴权/授权网关（AuthN→AuthZ→core）+ 提取 `packages/web`（复用 mobile stream reducer/approval/reconnect），core 保持 UI-agnostic、经受控 stdio 驱动 **per-user worker**。分期：Phase 1 单管理员闭环（bootstrap/login → 登记 workspace → 浏览器建/恢复 session → 流式+审批+停止+重启恢复），Phase 2 per-user worker + 私有 data root 补真多用户隔离，Phase 3 再选 tunnel/relay/SSO/rooms/browser 分叉。**推进顺序（已定）**：I1 与本轮 Arena/state 架构债已完成；server Phase 1 可直接 build against core public API。Phase 2 仍推荐 per-user 进程隔离，用于 tenant/security/data-root 边界；它不再是规避 `state.ts` singleton 的前置，因为该单例已删除。未决问题见文档 §9（self-host vs SaaS、公网入口、credential 归属、worker 隔离粒度等，需用户拍板）。
- **Pet 顶层 agent 主体（用户私人总管/编排大脑）**（体量 L，**已实现**：Pet Phase1 全部 15 step + 左下角可开关小 pet 挂件已完成，分支 `loop/nightly-batch/r5` 已合入 main `0c477805`）｜设计稿：`docs/nightly-2026-07-12/pet-top-level-agent-design.md`；桌面 UI 设计：`docs/nightly-2026-07-12/pet-desktop-ui-design.md`｜锚点：`docs/todo/im-gateway-remote-orchestration.md:86`（§6 assistant 主体衔接口）、`packages/core/src/protocol/chat-session-manager.ts:45`、`packages/core/src/protocol/chat-session.ts:64`（pendingApprovals）、`packages/core/src/tool-system/builtin/agent-notifications.ts:401`、`packages/core/src/tool-system/permission.ts:22`、`packages/core/src/protocol/server.ts:295`（idle wake）｜实现摘要：侧栏入口 + overview 内嵌宽面板 + running dot + L0/L1 右下角 toast peek + 左下角挂件；desktop 全量测试全绿。Phase 1 保持单用户本地边界，不做 Team/mesh，不替用户审批或回答，不绕 permission gate，不自动 L2。
- **Workspace / Profile / 数字人**（体量 L）｜锚点：`docs/todo/workspace-profile-讨论稿.md:86`、`packages/core/src/settings/schema.ts:25`、`packages/core/src/prompt/composer.ts:270`｜现状：已有 capability overlay、preset、plugin、普通 `userProfile`，但没有 `WorkspaceProfile` schema、激活/切换事务、主指令注入和数字人记忆层。修法：先落全局 profile 库 + activeProfile 记录 + capability 批量写入，再接 mainInstruction、portable memory、Team Board。
- **Workspace 数据源绑定**（体量 L）｜锚点：`docs/nightly-2026-07-10/large-feature-breakdown.md:139`、`packages/core/src/settings/schema.ts:25`、`packages/desktop/src/renderer/credentials/LinkTab.tsx:9`｜现状：Connections/Link 已有固定 catalog、OAuth 凭证状态和退出，不再是完全静态壳；但仍没有独立的 SourceDefinition / WorkspaceSourceBinding、外部源连接状态、Figma/issue/云盘 scope 分配和按 workspace/profile 求交的读取面。修法：设计数据源 schema、权限/凭证绑定和按 workspace/profile 注入的读取面。
- **worktree session 隔离深化（外部 agent 自动隔离）**（体量 L）｜锚点：`docs/todo/worktree-session-isolation-research.md:331`、`packages/core/src/tool-system/builtin/drive-claude-code.ts:59`、`:263`、`packages/core/src/cc-orchestrator/external-agent-session-store.ts:17`｜现状：主 session workspace pointer、下一轮 cwd、DriveAgent resume cwd 绑定已落地；DriveAgent schema 仍无 isolation/baseRef/include，成功绑定也只记录 cli/sessionId/cwd，尚未建立自动 per-run worktree 生命周期。剩余是并行自动隔离、完成后保留/清理提示、`.worktreeinclude`/baseRef/cleanup。修法：给 DriveAgent 增 isolation 策略和生命周期 UI，再扩展 include/baseRef/lock。
- **工程质量 P7：builtin 工具集成 harness / Electron e2e / CI 覆盖率**（体量 L）｜锚点：`packages/core/src/tool-system/builtin/tool-coverage.test.ts:95`、`package.json:17`、`.github/workflows/ci.yml:45`、`packages/desktop/scripts/smoke-panels.mjs:1`｜现状：builtin 59 项覆盖矩阵已落地（44 covered / 15 skip，且明确是 informational）；根脚本仍无 coverage/e2e/smoke，CI 仍跑 targeted tests，desktop 只有 Playwright 依赖和一次性 smoke script，未成稳定集成/e2e 基座。修法：共享 ToolRegistry fake-context harness、mock provider smoke、Electron `_electron` harness、CI xvfb/e2e 分层，最后加覆盖率目标。

---

## 约束边界（明确不做）

- **quick-chat 不做 Pi 式 parent 指针树状 session**：快聊是用完即走短对话；需要合并时用 fork/复制派生，不引入树状会话模型。
- **IM gateway MVP 不做编排大脑 / IM 内富交互审批 / 多租户**：gateway 只做通道、隧道生命周期和入口回推；高阶跨 session 指挥留给未来 assistant 主体。
- **WorkspaceProfile MVP 不做同一 workspace 同时激活多个 Profile**：当前决策是同一 workspace 一个 active Profile，可切换但不并存；项目专属定制仍放 `CLAUDE.md`/项目指令。
