# 本地任务中心 Implementation Plan

> 设计来源：`docs/superpowers/specs/2026-09-01-local-task-center-design.md`
> 范围：本地桌面端；云端、沙箱、团队协作均不在本计划
> 原则：每批 RED → 最小实现 → 下游验证 → 单条 Conventional Commit

**Goal:** 用可重建的持久读模型统一展示并控制 Session、Run、自动化、Mimi 委派与后台工作。

**Architecture:** 权威 store 不迁移；main projector 事件摄入 + 启动扫描；renderer 只消费规范化记录，动作按来源路由并二次校验。

## T1 — 纯模型与映射

**Files:**
- Create: `packages/desktop/src/main/task-inbox/task-inbox-types.ts`
- Create: `packages/desktop/src/main/task-inbox/task-inbox-mappers.ts`
- Test: 同目录 `*.test.ts`

- [ ] 定义 V1 record/status/source/capability schema 和严格 parser。
- [ ] 用 table tests 覆盖 Session、legacy Run、Cron、Mimi、子 Agent、后台 job、external runtime 映射。
- [ ] 证明关联的 long-task + Session、automation + execution 不会生成重复主卡。
- [ ] 证明 terminal 不能被更旧的 running 事件回滚。

## T2 — 持久 projection store

**Files:**
- Create: `task-inbox-store.ts` + tests

- [ ] RED：跨实例恢复、同 key upsert、活跃项永不淘汰、终态上限 2,000。
- [ ] RED：半截 JSON 隔离且原字节不被覆盖；未知字段/坏条目逐条隔离。
- [ ] 使用仓库既有原子写/锁原语，权限 `0600`。
- [ ] 支持 store schema version 与整库重建，不做权威数据迁移。

## T3 — projector 与启动对账

**Files:**
- Create: `task-inbox-projector.ts`, `task-inbox-reconcile.ts`
- Modify: main 组合根（装配依赖，不把逻辑堆进 `index.ts`）
- Test: projector/reconcile integration tests

- [ ] 注入各来源 reader 与事件 seam；projector 本身不 import 全局单例。
- [ ] 启动扫描 Session、long-task、Cron、legacy Runs，随后合并 live registry/external runtime。
- [ ] 模拟崩溃前最后状态 running、磁盘已 terminal，重启对账后必须 terminal。
- [ ] 单个来源 throw 时保留其他来源并产生局部错误。
- [ ] 事件重放/乱序/重复测试。

## T4 — 动作路由

**Files:**
- Create: `task-inbox-actions.ts` + tests
- Reuse: coordinator、agent bridge、automation service、background managers

- [ ] renderer 只传 taskKey/action/expectedRevision。
- [ ] 路由 Mimi cancel/pause/resume/retry/verify；复用 coordinator 的状态机。
- [ ] 路由 automation pause/resume/run-now，明确它控制 schedule，不冒充执行 Session cancel。
- [ ] 仅在 live source 能力存在时开放 Session/subagent/background cancel。
- [ ] legacy Run 返回 `unavailable`，不修改磁盘 snapshot。
- [ ] stale revision、重复 cancel、来源消失与 worker 断线都返回结构化结果。

## T5 — IPC / preload

**Files:**
- Create: `task-inbox-ipc.ts`
- Modify: `packages/desktop/src/preload/index.ts`, `types.d.ts`
- Test: IPC validation/ownership tests

- [ ] list/get/act/onChanged API 做枚举、长度、分页上限校验。
- [ ] 窗口销毁后解除订阅；不允许 renderer 注入 sessionId/cwd/command。
- [ ] snapshot/version 协议可处理 missed event，通过重新拉取收敛。

## T6 — 任务中心页面

**Files:**
- Create: `packages/desktop/src/renderer/task-inbox/*`
- Modify: `PageRegistry`, navigation, i18n
- Test: reducer/filter/action UI tests

- [ ] 四组默认排序：等待、运行、失败、完成。
- [ ] 来源/项目/状态筛选与搜索；空态、局部错误、stale 状态。
- [ ] 根据 capabilities 渲染动作，取消/重试沿用确认对话框。
- [ ] 打开原 Session/Mimi/automation/legacy Run 的导航测试。
- [ ] 键盘导航与无障碍名称覆盖。

## T7 — Mimi 读模型接入

**Files:**
- Modify: Mimi task query/provider seam
- Test: Mimi task view parity tests

- [ ] Mimi 的任务查询读取 projector，不再单独只查 long-task ledger。
- [ ] 查询输出与任务中心按 taskKey 一致，不泄漏后台内部字段。
- [ ] projector 不可用时降级到现有 long-task 查询。

## T8 — 集成、性能与灰度

- [ ] 真机：并行启动 Mimi 委派、自动化、子 Agent 和 external runtime，状态实时聚合。
- [ ] 真机：运行中杀 app → 重启 → 对账恢复 → 完成结果写回聊天。
- [ ] 压测 2,000 终态 + 50 活跃记录，列表/筛选无明显卡顿。
- [ ] `taskInboxV1` 开关默认先关闭，内部验证后再默认开启。
- [ ] 全仓门禁与 desktop build/typecheck 全绿。

## Definition of Done

- [ ] 读模型可删可重建，任何失败不改变权威任务数据。
- [ ] 同一逻辑任务不重复成卡，重启/乱序/重放测试全绿。
- [ ] 所有动作都有权威状态二次校验且不会由 renderer 指定真实目标。
- [ ] 用户可从任意卡片回到来源，等待处理项不再藏在五个入口。
