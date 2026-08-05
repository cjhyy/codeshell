# TODO

> 已完成项一律删除（记录在 git 历史与记忆里）。本文件只保留**未完成**的待办。
> 分区规则：**小 feature = 体量 M 及以下（M/S/XS），可单会话直接着手**；**大功能升级 = 体量 L**，需先方案设计再分阶段落地。
> 最近一次核对：2026-08-05（0.8.0 发布前核对；08-04 review 中已完成的 Link 设备码、LinkTab 与旧 todo 发布说明项已清理）。
> **仓库状态（2026-07-27 实测）**：main 与 origin/main 完全同步（ahead/behind 均为 0），工作区干净。本文件历史版本多处写的「未 commit / 在工作树 / 未 push」均已过期作废——包括 2026-07-15 模块边界大拆分、07-16 优化冲刺 2、07-20 Pet 外部会话，全部已进 main 并推送。
> 2026-07-15 模块边界大拆分（已合入 main）：core 去领域化（pet 迁出为 `packages/pet`，经通用 extension 钩子组合；三入口导出面收敛；protocol↔engine/session↔engine/settings→engine 四组倒置消除；goal/session-usage 下沉）、desktop 传输层抽出 `packages/server`、AgentBridge 拆出纯 Node `WorkerBridgeCore`、mobile 逻辑层抽出 `packages/web`、identity/data-root 注入基础落地（服务端部署项现状段已同步更新）。monorepo 现为 10 包（arena/cdp/chat/coding/core/desktop/pet/server/tui/web）。实施计划：`docs/superpowers/plans/2026-07-15-*.md`。
>
> **验收门实测（2026-07-27）**：`bun test packages/pet packages/desktop/src/main/pet` → 393 pass / 0 fail；根 `bun run typecheck` 干净；`packages/desktop` typecheck（含 tsconfig.mobile）干净；`packages/pet/dist/index.disclosure.js` 已产出。全仓真正开放的代码待办注释仅 1 条（见下「代码内待办」）。

---

## 小 feature（体量 M 及以下，现在可直接着手）

> 2026-07-12：上一批 12 项小 feature 已全部落地并合并回 main——core 引擎 5 项（goal-judge 上下文重构、prompt-cache 归因、拆 engine.ts、子 agent sandbox/mcp、密钥脱敏硬化）、desktop 2 项（review-panel workspace + fork busy-guard）、跨层 5 项（MCP OAuth 闭环、浏览器复制地址、DriveAgent 跳转、手机发图、命名收敛第一批）、快聊对齐 codex `/side`（修主聊消息串漏）。逐线只读 codex 复审+修复+复核全绿。实施记录见 `docs/todo/small-features-2026-07-10/PIPELINE-SUMMARY-*.md`。

> 2026-07-16:优化冲刺 2 工作流 A(设置中心信息架构统一)已落地——SettingsPage scope 模型(全局/按项目切换)、数字人/数据源/指令文件/项目概览四个新模块、project_config 路由改为预选项目 scope 的设置中心(ProjectConfigPage 删除)、侧边栏一级设置入口、customize 双门收口、SidebarNav 死代码清理。设计稿:`docs/superpowers/specs/2026-07-16-optimization-sweep-2-design.md`;计划:`docs/superpowers/plans/2026-07-16-settings-center-ia.md`。工作流 C(core 债务)已完成 2026-07-17:C4 守卫死链修复、C3 三个可直跑 SDK examples、C2 installer/marketplace/onboarding/updater 导出迁 /internal(0.8 breaking)、C1 拆 runExclusive(1787→294 行,7 个 run-\*.ts 模块 + 10 个私有方法,行为零变化,全仓 6897 测试绿、protocol 零 diff)。计划:`docs/superpowers/plans/2026-07-17-core-debt-cleanup.md`。工作流 D(插件贡献点)已完成 2026-07-17:D1 全屏页面注册表 PageRegistry(对齐 PanelRegistry)+ ViewMode 开放 union + 侧边栏注册表驱动(视觉零变化)+ logs/runs 迁移 render 缝;D2 沙箱面板图标白名单放宽至 87 名 + 权限扩容 workspace.info/notifications.send(上限仍 8);Non-goals(capability 包 UI 贡献字段/插件进一级导航/pet UI 插件化)守住;向后兼容。计划:`docs/superpowers/plans/2026-07-17-plugin-contribution-points.md`。工作流 B(Mimi 会话归档)已完成 2026-07-17:B2 工作台五分组结构化分类(未分类不隐身)+ dismiss id 契约抽 shared 单一真源;B3 core archivedAt 原语 + listDiskSessions 默认过滤 + 完成7天自动归档 + 复用候选退出 + refreshCatalog 增量 mtime 游标;B1 core 通用 summarizeRange 原语 + engine archiveTurnRange/protocol archive_range + pet topic-segment 纯函数 + main PetWorkMemoryStore/PetSegmentController + Mimi 聊天流分隔线/纪要卡片(经 clientMessageId 端到端打通)。core/engine 无 pet 字面量。计划:`docs/superpowers/plans/2026-07-17-mimi-session-archival.md`。**优化冲刺 2(A/B/C/D 四工作流)全部落地。** 遗留跟进(均非阻塞,已确认可接受):①委派刚 launch 即记 completed 致携带纪要「未完成任务」路径暂空,待真实委派完成信号;②getWorkMemory IPC 无 UI 消费者(UI 走 snapshot,API 完整性保留;2026-07-27 复核仍只有 preload 声明);③设置中心 scope 切换未保存内联草稿的离开确认(见下 XS 项)。

> 2026-07-23:**Session 世界渐进披露 v1 已落地**(11 任务 TDD 计划全部执行完)。产出:pet `disclosure/` 子入口(最新 assistant 文本读取器、跨 session TodoWrite 快照读取器、磁盘 work-session catalog + selector 哈希、有界 transcript grep 搜索)、Mimi 的 `Sessions` 两级只读披露工具(host 接线 sessions root + 可见性门禁 + 按 lastActivityAt 降序而非 id 序)、resume 白名单打通(Sessions 搜到的 session 可被 DelegateWork 复用,已归档与非 desktop session 排除)、工作台 session 行展开「最新结果」、Cmd-K 会话内容搜索模式。`packages/pet` 主入口保持零 node 内置模块(node:crypto/node:fs 仅限 `disclosure/` 与动态 import)。设计稿:`docs/superpowers/specs/2026-07-23-session-world-progressive-disclosure-design.md`;计划:`docs/superpowers/plans/2026-07-23-session-world-progressive-disclosure.md`(注:计划内 checkbox 未回勾,以 commit 与本条为准)。

> 2026-07-24:**Mimi 记忆中心 + segment 收尾管线已落地**。架构要点:**segment 收尾是唯一触点**——`PetSegmentController.beginTurn` 检测到 idle 切段时,一次 aux 调用同时产出 journal(事件档案)与 auto 记忆,再 `archiveRange` 压缩刚关闭的段,聊天 UI 与模型上下文都不再无限增长。产出:aux session 收尾小结服务(并发上限 + in-flight 去重)、pet memory auto source + journal store、journal/segment-transcript/auto-extract IPC、Mimi 记忆中心页面(从设置进入)、工作台「需跟进」区块。决策记录:素材只从 mimi 对话提取(core memory/dream/pending 体系完全不动)、自动提取直接写入标 `source: "auto"` 不做待确认收件箱、事件档案只含 mimi 对话段落小结。设计稿:`docs/superpowers/specs/2026-07-24-mimi-memory-center-design.md`。
>
> 同批产品收敛(有意 revert,非回退失败):①`16ccdfbe` 删除跨 session TodoWrite 聚合区块(704 行)——工作台待办改由 **Mimi 收尾小结**承担,不再聚合 TodoWrite;②`e20d1caf` 删除内联行提醒;③`73c3c143` 工作台移除记忆区块(记忆归记忆中心页面)。收尾提醒改为一行式,且只在真实 follow-up 时触发。**注意**:07-23 计划里的 Task 9(TodoWrite 聚合)已被本次决策作废,读该计划时勿当待办。

> 2026-07-28:**数字人 feature 整体优化已落地**。此前数字人是「配了等于没配」——8 个内置除一句提示词外能力全空,还带编造的使用量;声明的 skill 只 force-enable、从不获取。本轮补齐全链路:
>
> - **自带依赖**:profile 新增可选 `requires`(skill 来源 + 外部命令),与 plugins/skills/mcp/agents 分工——前者管「怎么弄来」,后者管「弄来后启用哪些」。启用前预检 → 列出将执行的命令确认 → 跑 `npx skills add`。`scope` 只允许 project(`-g` 落在 `~/.claude/skills`,不在 scanner 三个根内);repo 值双重校验挡 `--flag`/`../`/`;rm -rf` 注入。
> - **仓库分发**:数字人不寄生插件市场,有独立通道(`core/profile/catalog*.ts`)。设置 › 数字人 › 数字人仓库填 `owner/repo` 克隆;广场卡片显示来源仓库;`exportProfileRepo` 把库里的数字人写成可 push 的仓库骨架(单个 JSON 只能人肉传,仓库骨架别人填 owner/repo 就能装)。配套目录:`cjhyy/mimi-humans`(3 个视频制作数字人,已验证真实克隆 + requires 完整 + 发布产物回读闭合)。
> - **清理**:8 个空壳内置与编造 usageCount 全删;3 个 curated teams 删除(建立在已被 Session-first 取代的 Pet-led teams 模型上);空目录不再堆一屏空控件。
> - **修 bug**:①编辑器保存会静默抹掉 `requires`(把仓库来的数字人打回空壳);②Radix 点遮罩/Esc 直接丢弃未保存改动;③归档会话被当成活引用阻止删除;④i18n 占位符写成 `{{name}}` 导致界面显示大括号;⑤删除报错发生在确认之后且是英文原文带 session id。
> - **视觉**:TopBar 最后一个原生 `<select>` 换 shadcn;卡片 7 个平铺控件收敛为「一个主行动 + 项目默认 + 溢出菜单」。
>
> 遗留(非阻塞):①`requires` 只能在定义 JSON 里写,编辑器为只读展示——图形化编辑依赖字段增删待后续;②发布只生成骨架,`git init/push` 仍需用户自己做;③仓库更新要手动移除再添加,没有「检查更新」按钮。

**未完成项(XS,可单会话直接着手):**

- **设置中心 scope 切换时未保存内联草稿的离开确认**(体量 XS)。现状:`packages/desktop/src/renderer/settings/SettingsPage.tsx:105` 注释说明 draft-heavy 编辑器仍沿用旧的 guarded scope picker。期望:切换 scope 时若存在未保存内联草稿(如 McpSection 内联编辑器),给离开确认或按原 scope 提交。预存问题,但设置中心让它更易触达。

**2026-08-04 review 遗留跟进**(当日 5 路并行 review + 修复批 `f4e07b7f..95ce222c` 后仍开放的项;已修项见 git 历史,勿重复施工):

- **Link 真机/真 token 验证**(体量 S,验证任务非编码)。①各 provider 用真 token 实测一遍 action 响应形状——API 版本头已改回文档版本(GitHub `2022-11-28`/Notion `2022-06-28`),但响应解析没对过真实服务,测试全是 stub fetch;②CLI login 流:`packages/core/src/links/cli.ts` 所有 login 都在 `child.stdin.end()` 下跑,`gh auth login --web` 会等"Press Enter"、`vercel login` 无参要交互选方式,真机上可能 EOF 失败。`ntn`(Notion)与`td`(Todoist)的官方身份及当前命令已于 2026-08-05 对照官方文档确认。
- **微信 hold-cursor 重试与 5 分钟 maxMessageAgeMs 的交互**(体量 S)。`packages/chat/src/wechat.ts`:handler 停摆 >5min 后,重试消息被 `normalizeInbound` 按"太旧"丢弃、`batchAccepted` 置真、cursor 提交——至少一次投递在 5 分钟外静默退化为至多一次。期望:重试路径豁免 age 过滤,或丢弃时显式记日志。
- **通知 pet/tunnel 事件无 deliveryKey 的进度键碰撞**(体量 XS)。`packages/chat/src/notification-relay.ts:119`:无 deliveryKey 的事件用 `streamId:eventId` 做进度键,server 支持的 resetCursor 回滚保留 streamId,重发 id 可能撞上上一世代"已投完"的进度记录导致新通知被跳过。期望:pet/tunnel publish 也带 deliveryKey。
- **事件 outbox 全量 writeFileSync 在 Electron 主线程**(体量 S,性能)。`packages/desktop/src/main/im-gateway-control-server.ts`:每次 publish 和 ack 轮询都同步全量重写(上限 96MB,现实数百 KB–MB),最坏卡 UI 事件循环。期望:移到 worker/异步写,或增量 append。
- **legacy 回执识别正则耦合散文文案**(体量 XS)。`packages/desktop/src/shared/pet-host-action-receipt.ts:42` 用中文散文正则(`消息已发送到 …。`)识别 `packages/desktop/src/main/pet/host-action-reply.ts` 生成的旧回执,无共享常量与跨文件测试;含 `。`/`，` 的目标名已经匹配失败,文案一改旧 transcript 的替换展示就静默失效。期望:抽共享常量或加跨文件契约测试。
- **mobile-remote 门禁小项**(体量 XS)。`packages/server/src/mobile-remote/access-passcode.ts`:①challenge 页 `<script>` 里 `JSON.stringify(path…)` 未做 `<` 转义,防御纵深补 `.replace(/</g,"\\u003c")`;②爆破锁定为进程内全局态,重启清零且可被远端恶意锁 60s(注释已声明是权衡,可接受则关闭此条);③无 JS 的 GET 兜底仍把明文口令送进隧道访问日志,值得一条代码注释。

---

## rc.18 发版遗留（非阻塞项，发 0.7.0 正式版前处理）

> 本次核对后暂无未完成项。

---

## 大功能升级（体量 L，需方案设计 + 分阶段落地）

- **Pet 全局 Session 实时态势 + 独立窗口控制台**（体量 L，**主体已完成；2026-07-20 补齐外部 CLI 接入 + 卡片安全摘要**）｜**产品结论**：每个正常 CodeShell 工作 Session，以及独立 Codex CLI / Codex App / Claude Code CLI Session，都应由 host 代理自动向 Pet 推送结构化活动事件（开始、排队、模型处理、工具调用、等待审批/回答、阶段变更、完成/失败/取消），Pet 以同一份可持久化 projection 实时维护全局工作视图；不依赖 Session 手动调用 `ReportToPet`，不让 Pet 轮询/偷读完整 transcript，也不在每个事件上唤醒 Pet LLM。投影仅携带 Session 身份、任务/工作区、安全状态摘要、待处理决策、时间戳与终态，不传完整对话、工具参数/输出、文件内容或模型思考。**独立 Pet 窗口**定位为随时可见的轻量实时控制台：全局列表展示 projection 中所有可见 Session，与完整 Pet 页面共用数据源、已读状态和路由，不建第二份状态库。**现状（2026-07-20 落地，已合入 main 并推送；原 `worktree-pet-external-sessions` 分支已删除）**：①CodeShell 内普通 Session 事件驱动 projection、独立窗口、全局卡片、自动推送早已完成；②**外部 Codex CLI/App 与 Claude Code CLI 会话已接入**——`packages/desktop/src/main/pet/external-session-adapter.ts` 通用 per-CLI adapter（周期发现 `~/.codex`/`~/.claude` 会话文件 + `watchFile` tail + 元数据归约，只带 runState/phase/工具名，绝不带 transcript 内容/工具参数/文件内容进投影），作为 `PetStateAggregator` 第三数据源，独立于 worker 生命周期；③**两个从源头启停的开关（默认关）**：`pet.showExternalCodexSessions` / `pet.showExternalClaudeSessions`，关闭时 adapter 完全不扫描/不 tail，设置中心（数字人区块，全局 scope）双 Switch 热调谐；④外部会话卡片带 CLI 徽章、禁用跳转（外部无 CodeShell 内目标）；⑤卡片安全摘要：等待决策卡片按 pending 最高 `riskLevel` 显示风险徽章 + 工具名。实施计划：`docs/superpowers/plans/2026-07-20-pet-external-codex-sessions.md`。剩余 follow-up（均非阻塞）：①外部会话卡片点击跳转到 cc-room（现禁用）；②外部会话可见性的 per-project scope（现仅全局开关，2026-07-27 复核：`showExternalCodexSessions`/`showExternalClaudeSessions` 均默认 false 且只有全局 scope）；③外部会话无"等待审批/排队"感知（Codex/Claude transcript 不记录这类事件，诚实呈现 running/idle/dormant——属上游数据限制，倾向不做）。
- **服务端部署 + Web Client（无账号体系）— 后续阶段**（体量 L，**Phase 1' 已完成 2026-07-15，2026-07-16 交付闭环已补齐**：`code-shell-serve` headless host（`packages/server/src/serve/`：AccessPasscode 门禁 + 防遍历静态托管 + WS↔stdio-worker 薄管道 + spawn-on-first-frame + 崩溃记账）+ `packages/web` 独立浏览器 SPA（vite `dist-app`，说 core JSON-RPC 协议：会话列表/新建/恢复、流式渲染、工具审批与 ask-user 卡片、停止、断线重连 + worker 退出横幅）+ `WorkerBridgeCore` 迁入 server 包（desktop 改从包导入）。SPA 已复用成熟 stream reducer，tool result/富事件/会话标题与 workspace 路径已闭环；标准 `bun run build` 已直接生成 `dist-app`。集成测试 + reducer/CLI 单测 + 真 worker 端到端 smoke 已验证 passcode→SPA→会话→工具审批/结果→worker 崩溃横幅→自动重启。用法见 `packages/server/README.md`。架构决策：浏览器是 core 协议一等前端，不复刻 desktop 的 mobile 编排器。剩余阶段：①公网入口（tunnel/反代 TLS 指引或复用 TunnelManager）；②配对/受信设备层（TrustedDeviceStore 已在包内，接到 serve 门禁后面）；③web UI 打磨（transcript 渲染增强已完成；仍缺 attachment、多 workspace 切换））｜设计稿：`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md`｜锚点：`packages/core/src/protocol/server.ts`（resolveIdentity 选项）、`packages/core/src/protocol/chat-session-manager.ts`（forIdentity/dataRoot）、`packages/core/src/cli/agent-server-stdio.ts`（CODE_SHELL_DATA_ROOT）、`packages/server/src/index.ts`、`packages/web/src/index.ts`、`packages/desktop/src/main/worker-bridge-core.ts`｜现状（2026-07-15 模块拆分后大幅推进）：**传输层已独立**——原 Electron main 内的 HTTP+WS host/配对/passcode/tunnel/rooms/上传整体抽为 `packages/server`（纯 Node、零 electron），胶水收敛为 desktop `mobile-remote-orchestrator.ts`；**浏览器客户端种子已独立**——mobile 的 stream reducer/approval/reconnect 逻辑层抽为 `packages/web`；**worker 驱动核心已独立**——AgentBridge 拆出传输无关的 `WorkerBridgeCore`（spawn/JSON-RPC 帧/注入），可直接被 server 复用驱动 per-user worker；**identity 基础已落**——`ChatSessionManager` 支持 `identity`+`dataRoot`（per-identity manager + `<root>/identities/<id>` 隔离），`AgentServer.resolveIdentity` 钩子按连接分派并过滤会话列表，stdio worker 支持 `CODE_SHELL_DATA_ROOT`；settings/credentials/session-memory 均有 root 注入口。仍缺：真账号体系（AuthN/AuthZ 网关本体）、per-user worker 编排、公网入口；进程级审批单例（ApprovalRouter/path approvals）按裸 sessionId 分键，多 identity 同进程需按连接注入独立 router（per-user worker 隔离则天然规避）。**推荐方案 A 不变**：`packages/server` 现在就是网关的宿主包，Phase 1 单管理员闭环可直接开工（bootstrap/login → 登记 workspace → 浏览器建/恢复 session → 流式+审批+停止+重启恢复），Phase 2 per-user worker + 私有 data root（用 WorkerBridgeCore + CODE_SHELL_DATA_ROOT），Phase 3 再选 tunnel/relay/SSO/rooms/browser 分叉。未决问题见文档 §9（self-host vs SaaS、公网入口、credential 归属、worker 隔离粒度等，需用户拍板）。
- **Workspace / Profile / 数字人 — 后续阶段**（体量 L，**MVP 第一步已完成 2026-07-15**）｜设计稿：`docs/superpowers/specs/2026-07-15-workspace-profile-design.md`；实施计划：`docs/superpowers/plans/2026-07-15-workspace-profile-mvp.md`；样例：`docs/examples/workspace-profile-sample.md`｜锚点：`packages/core/src/profile/resolve.ts`（sessionProfile 缝）、`packages/core/src/capability-control/overlay.ts`（effectiveProjectOverrides 咽喉）、`packages/desktop/src/renderer/settings/ProfileSection.tsx`｜已完成：`WorkspaceProfile` schema + 全局库（`~/.code-shell/profiles/`，identity dataRoot 天然隔离）+ 原子激活/切换/关闭事务（settings 单一 `profile` 子树全量重写）+ 能力折叠单一咽喉（用户手写 override 按 key 赢过 profile）+ preset 优先级 + 主指令注入（CLAUDE.md > mainInstruction > preset）+ 记忆三层（全局→数字人→局部）+ desktop 设置区块/TopBar 指示，30 测试全绿。**2026-07-15 增量（commit `5840d2e1`）**：①session 级绑定 + Pet 缝合已完成——engine 按 RunParams 接线 sessionProfile（`engine.workspace-profile-session.test.ts`）、Pet-led teams（`packages/pet/src/team.ts` + desktop `digital-human-team-service.ts`）、数字人市场 catalog（desktop `digital-human-catalog.ts` + `digital_humans` 页）。剩余阶段：②经验层运营（项目经验"提升"为数字人经验、MemoryWrite 写数字人层、dream 按数字人分桶）；③产品化 UI 补全（Profile Builder / Switcher 预览影响、Memory Studio）；④P4 本地导入导出/降级 plugin；⑤P5 marketplace 远程分发（本地市场页已有雏形，远程后置）。
  - **2026-07-18 架构更正已落地**：上述 Pet-led teams / Pet 缝合已被 Session-first 模型取代。数字人现在直接创建并绑定项目 Session，独立管理长期记忆；Session 协作只使用 `SendMessageToSession` 工具，把一条普通用户消息排入目标 Session，不创建 Handoff 实体、版本或订阅，也不暴露 Handoff UI；后续补充由来源 Session 再发一条消息。目标 Session 使用自己的当前数字人及项目 Skills 工作；数字人便携 skill 与项目 skill 分层，项目明确 override 优先；Pet 完全不接收数字人 / team 路由字段。主路径代码、编辑 UI、契约测试和架构文档均已同步。
- **Workspace 数据源绑定 — 后续阶段**（体量 L，**只读 MVP 已完成 2026-07-15**）｜ADR：`docs/todo/workspace-datasource-binding-adr.md`；实施计划：`docs/superpowers/plans/2026-07-15-workspace-datasource-readonly-mvp.md`｜锚点：`packages/core/src/sources/`、`packages/desktop/src/renderer/project-config/DataSourcesSection.tsx`｜已完成：SourceDefinition → WorkspaceSourceBinding → EffectiveSourceAccess 三层模型 + mock/mcp-resource/local-files 三种 adapter + ListSources/ReadSource 只读工具面（默认 deny、读取审批、二次校验、provenance、256 KiB 截断、密钥脱敏与 untrusted 包裹）+ 动态上下文 metadata 注入 + desktop 项目配置中心/全局 Connections 管理 + mock 纵切 e2e。剩余阶段：真实 OAuth provider adapter、Profile 求交接线（resolver `profile?` 参数已留）、写操作、上传文件解析/索引。

---

## 代码内待办（源码注释，2026-07-27 全仓扫描）

> 扫描口径：`packages/*/src` 下的 `// TODO:` / `// FIXME` / `// HACK` / `// XXX`。形如 `TODO 7.2`、`TODO §8.4` 的是历史章节引用（约 40 处），不是待办，已排除。

- `packages/coding/src/cc-orchestrator/external-agent-session-store.ts:146`（体量 S）：把同步轮询锁改成异步写队列，调用方不必阻塞。

---

## 约束边界（明确不做）

- **quick-chat 不做 Pi 式 parent 指针树状 session**：快聊是用完即走短对话；需要合并时用 fork/复制派生，不引入树状会话模型。
- **IM gateway MVP 不做编排大脑 / IM 内富交互审批 / 多租户**：gateway 只做通道、隧道生命周期和入口回推；高阶跨 session 指挥留给未来 assistant 主体。
- **WorkspaceProfile MVP 不做同一 workspace 同时激活多个 Profile**：当前决策是同一 workspace 一个 active Profile，可切换但不并存；项目专属定制仍放 `CLAUDE.md`/项目指令。
- **Mimi 工作台不做 TodoWrite 聚合**（2026-07-24 拍板，已 revert 实现）：工作台待办由 **Mimi 收尾小结**承担——aux 模型对已完成 session 的收尾摘要，不是跨 session 聚合 TodoWrite 快照。
- **Mimi 记忆中心不碰 core 记忆体系**（2026-07-24 拍板）：不改 core 的 memory 提取 / dream / pending；不做置信度分流、待确认收件箱、周月巩固总结、向量检索；不给 mimi 引入显式 session 概念（segment 即隐形 session）。
- **服务端部署不做账号体系**（2026-07-15 用户拍板）：不做 AuthN/AuthZ 网关、注册登录、多用户租户、per-user worker、SSO；访问控制只用 passcode + pairing token。identity/dataRoot 底座保留但不扩展。
