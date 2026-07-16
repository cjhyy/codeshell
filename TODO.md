# TODO

> 已完成项一律删除（记录在 git 历史与记忆里）。本文件只保留**未完成**的待办。
> 分区规则：**小 feature = 体量 M 及以下（M/S/XS），可单会话直接着手**；**大功能升级 = 体量 L**，需先方案设计再分阶段落地。
> 最近一次核对：2026-07-16（optimization sweep 已完成：Web 交付闭环、desktop 体验收口、core 技术债清理）。
> 2026-07-15 模块边界大拆分（未 commit，在工作树）：core 去领域化（pet 迁出为 `packages/pet`，经通用 extension 钩子组合；三入口导出面收敛；protocol↔engine/session↔engine/settings→engine 四组倒置消除；goal/session-usage 下沉）、desktop 传输层抽出 `packages/server`、AgentBridge 拆出纯 Node `WorkerBridgeCore`、mobile 逻辑层抽出 `packages/web`、identity/data-root 注入基础落地（服务端部署项现状段已同步更新）。monorepo 现为 10 包。实施计划：`docs/superpowers/plans/2026-07-15-*.md`。

---

## 小 feature（体量 M 及以下，现在可直接着手）

> 2026-07-12：上一批 12 项小 feature 已全部落地并合并回 main（未 push）——core 引擎 5 项（goal-judge 上下文重构、prompt-cache 归因、拆 engine.ts、子 agent sandbox/mcp、密钥脱敏硬化）、desktop 2 项（review-panel workspace + fork busy-guard）、跨层 5 项（MCP OAuth 闭环、浏览器复制地址、DriveAgent 跳转、手机发图、命名收敛第一批）、快聊对齐 codex `/side`（修主聊消息串漏）。逐线只读 codex 复审+修复+复核全绿。实施记录见 `docs/todo/small-features-2026-07-10/PIPELINE-SUMMARY-*.md`。

> 2026-07-16:优化冲刺 2 工作流 A(设置中心信息架构统一)已落地——SettingsPage scope 模型(全局/按项目切换)、数字人/数据源/指令文件/项目概览四个新模块、project_config 路由改为预选项目 scope 的设置中心(ProjectConfigPage 删除)、侧边栏一级设置入口、customize 双门收口、SidebarNav 死代码清理。设计稿:`docs/superpowers/specs/2026-07-16-optimization-sweep-2-design.md`;计划:`docs/superpowers/plans/2026-07-16-settings-center-ia.md`。工作流 B(Mimi 会话归档)/C(core 债务)/D(插件贡献点)待做,见设计稿。

> 本次核对后暂无未完成项。

---

## rc.18 发版遗留（非阻塞项，发 0.7.0 正式版前处理）

> 本次核对后暂无未完成项。

---

## 大功能升级（体量 L，需方案设计 + 分阶段落地）

- **服务端部署 + Web Client（无账号体系）— 后续阶段**（体量 L，**Phase 1' 已完成 2026-07-15，2026-07-16 交付闭环已补齐**：`code-shell-serve` headless host（`packages/server/src/serve/`：AccessPasscode 门禁 + 防遍历静态托管 + WS↔stdio-worker 薄管道 + spawn-on-first-frame + 崩溃记账）+ `packages/web` 独立浏览器 SPA（vite `dist-app`，说 core JSON-RPC 协议：会话列表/新建/恢复、流式渲染、工具审批与 ask-user 卡片、停止、断线重连 + worker 退出横幅）+ `WorkerBridgeCore` 迁入 server 包（desktop 改从包导入）。SPA 已复用成熟 stream reducer，tool result/富事件/会话标题与 workspace 路径已闭环；标准 `bun run build` 已直接生成 `dist-app`。集成测试 + reducer/CLI 单测 + 真 worker 端到端 smoke 已验证 passcode→SPA→会话→工具审批/结果→worker 崩溃横幅→自动重启。用法见 `packages/server/README.md`。架构决策：浏览器是 core 协议一等前端，不复刻 desktop 的 mobile 编排器。剩余阶段：①公网入口（tunnel/反代 TLS 指引或复用 TunnelManager）；②配对/受信设备层（TrustedDeviceStore 已在包内，接到 serve 门禁后面）；③web UI 打磨（transcript 渲染增强已完成；仍缺 attachment、多 workspace 切换））｜设计稿：`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md`｜锚点：`packages/core/src/protocol/server.ts`（resolveIdentity 选项）、`packages/core/src/protocol/chat-session-manager.ts`（forIdentity/dataRoot）、`packages/core/src/cli/agent-server-stdio.ts`（CODE_SHELL_DATA_ROOT）、`packages/server/src/index.ts`、`packages/web/src/index.ts`、`packages/desktop/src/main/worker-bridge-core.ts`｜现状（2026-07-15 模块拆分后大幅推进）：**传输层已独立**——原 Electron main 内的 HTTP+WS host/配对/passcode/tunnel/rooms/上传整体抽为 `packages/server`（纯 Node、零 electron），胶水收敛为 desktop `mobile-remote-orchestrator.ts`；**浏览器客户端种子已独立**——mobile 的 stream reducer/approval/reconnect 逻辑层抽为 `packages/web`；**worker 驱动核心已独立**——AgentBridge 拆出传输无关的 `WorkerBridgeCore`（spawn/JSON-RPC 帧/注入），可直接被 server 复用驱动 per-user worker；**identity 基础已落**——`ChatSessionManager` 支持 `identity`+`dataRoot`（per-identity manager + `<root>/identities/<id>` 隔离），`AgentServer.resolveIdentity` 钩子按连接分派并过滤会话列表，stdio worker 支持 `CODE_SHELL_DATA_ROOT`；settings/credentials/session-memory 均有 root 注入口。仍缺：真账号体系（AuthN/AuthZ 网关本体）、per-user worker 编排、公网入口；进程级审批单例（ApprovalRouter/path approvals）按裸 sessionId 分键，多 identity 同进程需按连接注入独立 router（per-user worker 隔离则天然规避）。**推荐方案 A 不变**：`packages/server` 现在就是网关的宿主包，Phase 1 单管理员闭环可直接开工（bootstrap/login → 登记 workspace → 浏览器建/恢复 session → 流式+审批+停止+重启恢复），Phase 2 per-user worker + 私有 data root（用 WorkerBridgeCore + CODE_SHELL_DATA_ROOT），Phase 3 再选 tunnel/relay/SSO/rooms/browser 分叉。未决问题见文档 §9（self-host vs SaaS、公网入口、credential 归属、worker 隔离粒度等，需用户拍板）。
- **Workspace / Profile / 数字人 — 后续阶段**（体量 L，**MVP 第一步已完成 2026-07-15**）｜设计稿：`docs/superpowers/specs/2026-07-15-workspace-profile-design.md`；实施计划：`docs/superpowers/plans/2026-07-15-workspace-profile-mvp.md`；样例：`docs/examples/workspace-profile-sample.md`｜锚点：`packages/core/src/profile/resolve.ts`（sessionProfile 缝）、`packages/core/src/capability-control/overlay.ts`（effectiveProjectOverrides 咽喉）、`packages/desktop/src/renderer/settings/ProfileSection.tsx`｜已完成：`WorkspaceProfile` schema + 全局库（`~/.code-shell/profiles/`，identity dataRoot 天然隔离）+ 原子激活/切换/关闭事务（settings 单一 `profile` 子树全量重写）+ 能力折叠单一咽喉（用户手写 override 按 key 赢过 profile）+ preset 优先级 + 主指令注入（CLAUDE.md > mainInstruction > preset）+ 记忆三层（全局→数字人→局部）+ desktop 设置区块/TopBar 指示，30 测试全绿。**2026-07-15 增量（commit `5840d2e1`）**：①session 级绑定 + Pet 缝合已完成——engine 按 RunParams 接线 sessionProfile（`engine.workspace-profile-session.test.ts`）、Pet-led teams（`packages/pet/src/team.ts` + desktop `digital-human-team-service.ts`）、数字人市场 catalog（desktop `digital-human-catalog.ts` + `digital_humans` 页）。剩余阶段：②经验层运营（项目经验"提升"为数字人经验、MemoryWrite 写数字人层、dream 按数字人分桶）；③产品化 UI 补全（Profile Builder / Switcher 预览影响、Memory Studio）；④P4 本地导入导出/降级 plugin；⑤P5 marketplace 远程分发（本地市场页已有雏形，远程后置）。
- **Workspace 数据源绑定 — 后续阶段**（体量 L，**只读 MVP 已完成 2026-07-15**）｜ADR：`docs/todo/workspace-datasource-binding-adr.md`；实施计划：`docs/superpowers/plans/2026-07-15-workspace-datasource-readonly-mvp.md`｜锚点：`packages/core/src/sources/`、`packages/desktop/src/renderer/project-config/DataSourcesSection.tsx`｜已完成：SourceDefinition → WorkspaceSourceBinding → EffectiveSourceAccess 三层模型 + mock/mcp-resource/local-files 三种 adapter + ListSources/ReadSource 只读工具面（默认 deny、读取审批、二次校验、provenance、256 KiB 截断、密钥脱敏与 untrusted 包裹）+ 动态上下文 metadata 注入 + desktop 项目配置中心/全局 Connections 管理 + mock 纵切 e2e。剩余阶段：真实 OAuth provider adapter、Profile 求交接线（resolver `profile?` 参数已留）、写操作、上传文件解析/索引。

---

## 约束边界（明确不做）

- **quick-chat 不做 Pi 式 parent 指针树状 session**：快聊是用完即走短对话；需要合并时用 fork/复制派生，不引入树状会话模型。
- **IM gateway MVP 不做编排大脑 / IM 内富交互审批 / 多租户**：gateway 只做通道、隧道生命周期和入口回推；高阶跨 session 指挥留给未来 assistant 主体。
- **WorkspaceProfile MVP 不做同一 workspace 同时激活多个 Profile**：当前决策是同一 workspace 一个 active Profile，可切换但不并存；项目专属定制仍放 `CLAUDE.md`/项目指令。
- **服务端部署不做账号体系**（2026-07-15 用户拍板）：不做 AuthN/AuthZ 网关、注册登录、多用户租户、per-user worker、SSO；访问控制只用 passcode + pairing token。identity/dataRoot 底座保留但不扩展。
