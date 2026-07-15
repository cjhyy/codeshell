# TODO

> 已完成项一律删除（记录在 git 历史与记忆里）。本文件只保留**未完成**的待办。
> 分区规则：**小 feature = 体量 M 及以下（M/S/XS），可单会话直接着手**；**大功能升级 = 体量 L**，需先方案设计再分阶段落地。
> 最近一次核对：2026-07-15（IM gateway hardening + Pet DelegateWork + DriveAgent worktree 隔离 + 工程质量 P7 已完成并从待办删除；merge `8014eefb`）。
> 2026-07-15 模块边界大拆分（未 commit，在工作树）：core 去领域化（pet 迁出为 `packages/pet`，经通用 extension 钩子组合；三入口导出面收敛；protocol↔engine/session↔engine/settings→engine 四组倒置消除；goal/session-usage 下沉）、desktop 传输层抽出 `packages/server`、AgentBridge 拆出纯 Node `WorkerBridgeCore`、mobile 逻辑层抽出 `packages/web`、identity/data-root 注入基础落地（服务端部署项现状段已同步更新）。monorepo 现为 10 包。实施计划：`docs/superpowers/plans/2026-07-15-*.md`。

---

## 小 feature（体量 M 及以下，现在可直接着手）

> 2026-07-12：上一批 12 项小 feature 已全部落地并合并回 main（未 push）——core 引擎 5 项（goal-judge 上下文重构、prompt-cache 归因、拆 engine.ts、子 agent sandbox/mcp、密钥脱敏硬化）、desktop 2 项（review-panel workspace + fork busy-guard）、跨层 5 项（MCP OAuth 闭环、浏览器复制地址、DriveAgent 跳转、手机发图、命名收敛第一批）、快聊对齐 codex `/side`（修主聊消息串漏）。逐线只读 codex 复审+修复+复核全绿。实施记录见 `docs/todo/small-features-2026-07-10/PIPELINE-SUMMARY-*.md`。

> 本次核对后暂无未完成项。

---

## rc.18 发版遗留（非阻塞项，发 0.7.0 正式版前处理）

> 本次核对后暂无未完成项。

---

## 大功能升级（体量 L，需方案设计 + 分阶段落地）

- **服务端部署 + Web Client + 账号体系**（体量 L，**roadmap/设计稿已出，待实现**）｜设计稿：`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md`｜锚点：`packages/core/src/protocol/server.ts`（resolveIdentity 选项）、`packages/core/src/protocol/chat-session-manager.ts`（forIdentity/dataRoot）、`packages/core/src/cli/agent-server-stdio.ts`（CODE_SHELL_DATA_ROOT）、`packages/server/src/index.ts`、`packages/web/src/index.ts`、`packages/desktop/src/main/worker-bridge-core.ts`｜现状（2026-07-15 模块拆分后大幅推进）：**传输层已独立**——原 Electron main 内的 HTTP+WS host/配对/passcode/tunnel/rooms/上传整体抽为 `packages/server`（纯 Node、零 electron），胶水收敛为 desktop `mobile-remote-orchestrator.ts`；**浏览器客户端种子已独立**——mobile 的 stream reducer/approval/reconnect 逻辑层抽为 `packages/web`；**worker 驱动核心已独立**——AgentBridge 拆出传输无关的 `WorkerBridgeCore`（spawn/JSON-RPC 帧/注入），可直接被 server 复用驱动 per-user worker；**identity 基础已落**——`ChatSessionManager` 支持 `identity`+`dataRoot`（per-identity manager + `<root>/identities/<id>` 隔离），`AgentServer.resolveIdentity` 钩子按连接分派并过滤会话列表，stdio worker 支持 `CODE_SHELL_DATA_ROOT`；settings/credentials/session-memory 均有 root 注入口。仍缺：真账号体系（AuthN/AuthZ 网关本体）、per-user worker 编排、公网入口；进程级审批单例（ApprovalRouter/path approvals）按裸 sessionId 分键，多 identity 同进程需按连接注入独立 router（per-user worker 隔离则天然规避）。**推荐方案 A 不变**：`packages/server` 现在就是网关的宿主包，Phase 1 单管理员闭环可直接开工（bootstrap/login → 登记 workspace → 浏览器建/恢复 session → 流式+审批+停止+重启恢复），Phase 2 per-user worker + 私有 data root（用 WorkerBridgeCore + CODE_SHELL_DATA_ROOT），Phase 3 再选 tunnel/relay/SSO/rooms/browser 分叉。未决问题见文档 §9（self-host vs SaaS、公网入口、credential 归属、worker 隔离粒度等，需用户拍板）。
- **Workspace / Profile / 数字人**（体量 L）｜锚点：`docs/todo/workspace-profile-讨论稿.md:86`、`packages/core/src/settings/schema.ts:25`、`packages/core/src/prompt/composer.ts:270`｜现状：已有 capability overlay、preset、plugin、普通 `userProfile`，但没有 `WorkspaceProfile` schema、激活/切换事务、主指令注入和数字人记忆层。修法：先落全局 profile 库 + activeProfile 记录 + capability 批量写入，再接 mainInstruction、portable memory、Team Board。
- **Workspace 数据源绑定**（体量 L）｜锚点：`docs/nightly-2026-07-10/large-feature-breakdown.md:139`、`packages/core/src/settings/schema.ts:25`、`packages/desktop/src/renderer/credentials/LinkTab.tsx:9`｜现状：Connections/Link 已有固定 catalog、OAuth 凭证状态和退出，不再是完全静态壳；但仍没有独立的 SourceDefinition / WorkspaceSourceBinding、外部源连接状态、Figma/issue/云盘 scope 分配和按 workspace/profile 求交的读取面。修法：设计数据源 schema、权限/凭证绑定和按 workspace/profile 注入的读取面。

---

## 约束边界（明确不做）

- **quick-chat 不做 Pi 式 parent 指针树状 session**：快聊是用完即走短对话；需要合并时用 fork/复制派生，不引入树状会话模型。
- **IM gateway MVP 不做编排大脑 / IM 内富交互审批 / 多租户**：gateway 只做通道、隧道生命周期和入口回推；高阶跨 session 指挥留给未来 assistant 主体。
- **WorkspaceProfile MVP 不做同一 workspace 同时激活多个 Profile**：当前决策是同一 workspace 一个 active Profile，可切换但不并存；项目专属定制仍放 `CLAUDE.md`/项目指令。
