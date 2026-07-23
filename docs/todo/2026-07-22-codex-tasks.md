# Codex 任务分发清单(2026-07-22)

> 由 `2026-07-22-overall-roadmap.md` 拆解。每张卡自带背景/锚点/验收,可独立分发。
> **T1 是一切 Pet 任务的前置**;同一 Phase 内其余任务可并行开工。
>
> **给 codex 的全局注意事项**:
> - 不要跑 `bun run format`(会重排全仓);只对改过的文件跑 prettier。
> - desktop 包有独立 typecheck/build,repo 根的检查不覆盖它;改 renderer 后在
>   `packages/desktop` 里跑 `bun run typecheck` + `bun run build`。
> - renderer UI 一律用 `@/components/ui`(shadcn)+ Tailwind 语义 token,不手写原生控件。
> - core 若给 Engine 加必填注入点,注意全仓有十余个手写 Engine fake 测试桩会连锁编译失败。

---

## Phase 0 — 工作树收口(前置,阻塞所有 Pet 任务)

### T1 · host-action 纵切收口(M)
**背景**:工作树有 28 文件 973 行在途改动:pet 包 host-action 信封
(`packages/pet/src/host-actions.ts`,kinds: mobileRemote/longTaskControl/memory)+
MobileRemote/ControlLongTask/Memory 三工具 + desktop `host-action-reply.ts` 执行折回 +
`pet-memory-store.ts`/`PetMemorySection.tsx`(持久可编辑 Mimi 记忆,注入每个 manager turn)+
chat 包 `PetChatResult.attachments`(IM 投递配对二维码)。
**做**:盘点缺失测试并补齐(信封校验、host 执行折回、memory store 上限/原子写、IM 附件路径),
全仓测试绿后按纵切分组 commit。
**验收**:`git status` 干净;全仓测试绿;desktop typecheck/build 绿。

### T2 · 14 号架构文档同步(S)
**背景**:`docs/architecture/14-digital-human-and-pet.md` 与 T1 落地后的代码脱节。
**做**:补三节——host-action 信封机制、Pet 记忆层(记忆表加第四行:
Pet/Mimi,desktop main `PetMemoryStore`)、PetStateAggregator 三数据源与外部 CLI 会话;
修正「Pet runtime 只接受 Workspace/复用 Session 选择器」表述(现另有 hostActionKinds、
runtimeContext)。依赖 T1 先落地。
**验收**:文档与代码一致,Primary implementation paths 补 host-actions/pet-memory-store。

## Phase 1 — Pet 补强(T1 后可并行)

### T3 · 委派完成信号真实化(M,Pet 线最高优先)
**背景**:DelegateWork 刚 launch 即记 completed,「携带纪要的未完成任务」路径为空
(TODO.md 遗留跟进①)。目标 Session 的终态事件其实已进 PetStateAggregator projection。
**做**:让 `PetLongTaskStore` 消费 aggregator 的终态(完成/失败/取消),launch 只记
running;打通未完成任务携带纪要路径。锚点:`packages/desktop/src/main/pet/
pet-long-task-coordinator.ts`、`pet-work-delegation-host.ts`、`pet-state-aggregator.ts`。
**验收**:委派后账本状态随真实终态迁移;新增覆盖 launch→running→terminal 的测试。

### T4 · 外部会话卡片直达 cc-room 会话详情(S)
**背景**:Pet 控制台的外部 Codex/Claude CLI 会话卡片现禁用点击(TODO follow-up①)。
CC Room 视图已存在且能打开外部会话对话流(`packages/desktop/src/renderer/cc-room/
CCRoomView.tsx`,`window.codeshell.ccRoom.*` IPC 全套已有,含 `OpenCliSessionRequest`);
缺的只是 Pet 卡片 → CC Room 的路由打通。
**做**:点卡片一跳直达——切到该项目的 CC Room 并定位到该会话的对话流。Pet 投影需携带
三个定位参数:CLI kind(claude-code/codex)、外部 sessionId、cwd(external-session-adapter
已归约出会话身份,确认三者都进了 projection;缺则补)。独立 Pet 窗口里点击时先聚焦/拉起
主窗口再路由。无法定位(如会话文件已删)时保持禁用 + tooltip 说明。
**硬约束——绑定查看,绝不隐式拉起 CLI**:现状 `RoomManager.open()` 尾部会
`createAgent(...).start()` spawn 外部 CLI 进程,`openLinkedSession` 也走这条路
(`packages/server/src/mobile-remote/room-manager.ts:551`)。Pet 跳转是纯导航/绑定动作,
需要一条 observe-only 路径:落到 CC Room 后从磁盘读 transcript 历史展示,不创建/不启动
resident agent;只有用户在 CC Room 内显式点「继续对话/接管」才走现有 open 拉起流程。
**验收**:从 Pet 全局卡片与 PetWorkTree 均可一键进入对应外部会话对话流;跳转全程零
CLI 进程 spawn(有测试断言 createAgent 未被调用);kind/cwd 不匹配时不误开其他会话;
CodeShell 内部会话卡片行为不变。

### T5 · 外部会话可见性 per-project scope(S)
**背景**:`pet.showExternalCodexSessions` / `pet.showExternalClaudeSessions` 现仅全局开关
(TODO follow-up③)。
**做**:沿 capabilityOverrides 项目层模式加 per-project 覆盖,设置中心项目 scope 出双 Switch;
关闭语义保持"从源头不扫描/不 tail"。
**验收**:项目层可覆盖全局;开关热调谐;默认行为不变。

### T6 · Mimi Memory 工具打磨(S)
**背景**:T1 落地后 Mimi 可写记忆(store 限 200 条/2000 字),缺 prompt 侧引导与去重策略。
**做**:Mimi prompt 补何时写/不写记忆的准则;写入前近似去重(同义条目更新而非新增);
`PetMemorySection` 展示 source(user/mimi)并可编辑删除。
**验收**:重复事实不产生重复条目;UI 可全量管理;有测试。

## Phase 2 — 数字人后续(与 Pet 线无硬依赖)

### T7 · 经验层运营(L,需先方案)
项目经验「提升」为数字人经验、MemoryWrite 写数字人层、Dream 按数字人分桶。
锚点:`packages/core/src/session/memory.ts`、`packages/core/src/services/auto-dream.ts`、
`packages/core/src/profile/`。

### T8 · Profile Builder / Switcher 预览 + Memory Studio UI(M)
切换数字人前预览能力影响;数字人记忆库可视化管理(对齐 DigitalHumanMemoryDialog 现状扩展)。

### T9 · 数字人本地导入导出(M)
Profile 打包导出/导入,降级为 plugin 的兼容路径(TODO ④)。

### T10 · 数字人 marketplace 远程分发(L,后置)
本地市场页已有雏形(`digital-human-catalog.ts` + `digital_humans` 页),远程源后置(TODO ⑤)。

## Phase 3 — 服务端部署剩余(无账号边界不变)

### T11 · 公网入口(M)
tunnel/反代 TLS 指引或复用 TunnelManager;锚点 `packages/server/src/serve/`。

### T12 · TrustedDeviceStore 接 serve 门禁(M)
配对/受信设备层接到 passcode 门禁后面(包内已有 store)。

### T13 · web SPA 打磨(M)
attachment 支持、多 workspace 切换;锚点 `packages/web/src/`。

## Phase 4 — 数据源绑定后续

### T14 · 真实 OAuth provider adapter(L,需先方案)
锚点 `packages/core/src/sources/`;沿 SourceDefinition→Binding→EffectiveAccess 三层模型。

### T15 · Profile 求交接线(S)
resolver `profile?` 参数已预留,接通数字人与数据源的求交过滤。

### T16 · 数据源写操作(M)+ T17 · 上传文件解析/索引(M)
默认 deny、审批、provenance 模式对齐只读 MVP。

## Phase 5 — 插件面板网络贡献点

### T18 · `network.fetch` 权限 + 域名白名单 + host 代理(M)
**背景**:沙箱面板 CSP `connect-src 'none'` + `supportFetchAPI: false`,外部数据面板做不了。
**做**:权限枚举加 `network.fetch`(`packages/core/src/plugins/installer/types.ts:3`)+
manifest 域名白名单 schema;`plugin-panel-bridge.ts` dispatch 加 case,host 校验白名单后
代发请求,限流/限响应大小;CSP 保持禁网(数据只走 bridge)。
**验收**:未声明权限/白名单外域名被拒;有恶意路径测试(重定向逃逸、超大响应)。

### T19 · 股票自选股参考插件(S,依赖 T18)
面板 UI + storage 自选股 + 代理 fetch 行情 + external.open 跳详情;
角色对齐 video-editor 参考插件,作为 T18 的验证载体。

## 零散小项(XS)

### T20 · 设置中心 scope 切换未保存草稿的离开确认
McpSection 等内联编辑器在 scope 切换时应给离开确认或按原 scope 提交(TODO 遗留④)。

## 明确不做(分发时防漂移)

- quick-chat 树状 session;IM gateway 编排大脑/IM 内富审批/多租户;
- 同一 workspace 多个 active Profile;服务端账号体系(passcode + pairing token 即全部);
- Pet 接收数字人/team 路由字段(Session-first 边界);
- 已接受不做:外部会话"等待审批/排队"感知(外部 transcript 无此事件,诚实呈现即可)。

---

## P1.5 — P0/P1 验收发现的修复批次(2026-07-22 审查,范围 c6702fab..6c8327b9)

> 机器验证:全仓 7271 测试绿(1 个失败为审查环境问题,正式仓库单跑通过)、desktop 双 typecheck 绿。
> 以下按严重度分组;F1–F3 必须修,F4 组建议修,F5 组低危可攒批。

### F1 · 旧终态重放杀死新 attempt(高,T3 遗留)
`transitionPetLongTask` 的乱序防护不拦 completed/failed/cancelled(`packages/pet/src/long-task.ts:357-367`),
投影终态无 `terminal.at` vs `task.startedAt` 围栏(`pet-long-task-coordinator.ts:480-516`)。
任务 retry(同 sessionId)或 DelegateWork 复用 dormant 已完成 session 后,在首条 live delta 前的任何
`reset`(30s 周期刷新/重启)会把磁盘上旧 attempt 的终态回灌,新 attempt 被瞬间打回 failed/completed,
并重复发 IM 回执——正是"launch 即 completed"的变体。
**修**:终态转移加 `transition.at >= task.startedAt`(或 attempt 级)围栏;补 retry 后重放、
复用 dormant session 两个测试。**顺带**:launch 短窗口 reset 产生假 interrupted 事件史
(`pet-long-task-coordinator.ts:541-549`,自愈但闪烁)可一并处理。

### F2 · observe 房间从正常入口打开后消息静默丢失(中高,T4 遗留)
`CCRoomView.openWithMode` 忽略 `openForSession` 返回的 `"observing"`,硬编码 running
(`CCRoomView.tsx:216-229`);composer 可输入但 `RoomManager.send` 返回 false,消息凭空消失。
**修**:尊重返回 status,observing 时渲染只读横幅 + 接管入口;`CCConversationView.send` 检查返回值。
**同根问题一并修**:①`openLinkedSession` 会把已存在的普通闲置房间降级为 observe-only
(`room-manager.ts:517-523`),纯导航不应产生此副作用;②手机端无 takeover 事件、RoomPublic
无 observe 标记(`mobile-remote-types.ts:312-321`),至少加标记让 web 端能显示只读态。

### F3 · PetMemoryStore 加载吞错可致整库被覆盖(中,T1 遗留)
`doLoad` 把一切读盘错误(含 EACCES/EIO 瞬态)吞成"空库"且 loadPromise 永久缓存
(`pet-memory-store.ts:56-73`),下一次任意写入原子地把 200 条记忆重写为 1 条。
**修**:区分 ENOENT(正常空库)与其他错误;非 ENOENT 时 load 失败应让 mutation 拒绝执行
(或重试加载),绝不从空 staged 持久化。补瞬态错误测试。

### F4 · 建议修(中危,可打包一批)
- **F4a 记忆所有权语义**(T1):①淘汰不分 source,mimi 连续 remember 可把 user 手写条目挤出
  200 条上限(`pet-memory-store.ts:193-198`)——user 条目应免疫淘汰或提示;②去重命中时新文本
  整体覆盖旧条目,mimi 措辞可静默改写 user 条目且 source 标签失真(`pet-memory-store.ts:84-93`,
  测试还固化了该行为)——命中 user 条目时保留原文或至少折回"已更新"而非"已记住"。
- **F4b 记忆注入契约**(T1):runtime context 只注入最新 24 条(`index.ts:1354-1360`)但工具
  描述声称全部记忆可见;>24 条时 Mimi 拿不到 memory_id 无法 forget。要么全量注入 id 索引,
  要么在 prompt/工具描述里如实声明窗口。
- **F4c codex backend 静默丢弃**(T3):DelegateWork schema 已向 Mimi 宣传 `executionBackend:
  "codex"`,但 `startDelegation` 不透传、delegation host 无 codex 分支,静默换成 CodeShell
  bypassPermissions 执行(`pet-long-task-coordinator.ts:213-224`、`pet-work-delegation-host.ts:68-105`)。
  短期先从 schema 摘掉 codex 或显式报"暂不支持",长期接外部 CLI 执行。
- **F4d 取消乐观提交**(T3):账本先转 cancelled 再调 `agent/cancel`,失败只进日志,真实 run
  孤儿运行而 UI 已宣告取消(`pet-long-task-coordinator.ts:757-776`)。失败时应回滚或标"取消失败"。
- **F4e takeover 权限旁路**(T4):接管静默继承持久化 mode(可能是 bypassPermissions),无模式
  确认(`room-manager.ts:562-572`);对比正常入口有模式选择框。接管时强制弹模式确认或降回 default。
- **F4f 导航 nonce 冲突**(T4):App.tsx 与 usePanelBuckets 两个独立计数器写同一
  `openCliSession.nonce`,交替点击 Pet 卡片与 DriveAgent 链接会吞掉第二次导航
  (`App.tsx:299,902`、`usePanelBuckets.ts:135,797`)。共用一个计数器。
- **F4g settings:set 阻塞**(T5):项目开关切换时同步 `await scanOnce()` 全量扫 `~/.codex`,
  大目录下卡 IPC(`external-session-visibility.ts:177-181`)。改射后不理,错误走 onReconcileError。

### F5 · 低危记录(攒批处理)
- 项目增删不触发外部会话 reconcile(快照到重启,T5-M1);`touchesExternalSessionVisibility`
  不识别子树删除 patch(T5-M3)。
- host-actions memory 分支缺显式 kind 判断,新增第 4 个 kind 时 fail-open(`host-actions.ts:82`,
  执行层有兜底,T1-L1);信封整批静默丢弃无日志(T1-L2)。
- IM 附件消费端无目录白名单(建议限定 userData/pet/qr,纵深加固,T1-L3);记忆文本不过滤
  控制字符(T1-L4)。
- 桌面回合 prompt 仍引导用 Memory/ControlLongTask 但工具只对 im-gateway 声明,缺"unavailable
  时怎么说"的兜底(`profile.ts:37-38`,T1-L5)。
- paused 任务漏真实终态(刻意设计,需产品确认,T3);openLinkedSession 失败降级到"未检测到
  CLI"安装页文案误导(T4);codex resolver 每次全量扫描未复用定向查找(T4,性能)。
