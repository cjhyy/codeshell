# 本地任务中心 Implementation Plan

> 设计来源：`docs/superpowers/specs/2026-09-01-local-task-center-design.md`
> 范围：本地桌面端；云端、沙箱、团队协作均不在本计划
> 状态：2026-10-08 已实现；验收依据见文末。
> 原则：独立任务分支实现，经整合、回归和 PR 门禁后合入 main。

**Goal:** 用可重建的持久读模型统一展示并控制 Session、Run、自动化、Mimi 委派与后台工作。

**Architecture:** 权威 store 不迁移；main projector 事件摄入 + 启动扫描；renderer 只消费规范化记录，动作按来源路由并二次校验。

## T1 — 纯模型与映射

**Files:**
- Create: `packages/desktop/src/main/task-inbox/task-inbox-types.ts`
- Create: `packages/desktop/src/main/task-inbox/task-inbox-mappers.ts`
- Test: 同目录 `*.test.ts`

- [x] 定义 V1 record/status/source/capability schema 和严格 parser。
- [x] 用 table tests 覆盖 Session、legacy Run、Cron、Mimi、子 Agent、后台 job、external runtime 映射。
- [x] 证明关联的 long-task + Session、automation + execution 不会生成重复主卡。
- [x] 证明 terminal 不能被更旧的 running 事件回滚。

## T2 — 持久 projection store

**Files:**
- Create: `task-inbox-store.ts` + tests

- [x] RED：跨实例恢复、同 key upsert、活跃项永不淘汰、终态上限 2,000。
- [x] RED：半截 JSON 隔离且原字节不被覆盖；未知字段/坏条目逐条隔离。
- [x] 使用仓库既有原子写/锁原语，权限 `0600`。
- [x] 支持 store schema version 与整库重建，不做权威数据迁移。

## T3 — projector 与启动对账

**Files:**
- Create: `task-inbox-projector.ts`, `task-inbox-service.ts`, `task-inbox-sources.ts`
- Modify: main 组合根（装配依赖，不把逻辑堆进 `index.ts`）
- Test: projector/reconcile integration tests

- [x] 注入各来源 reader 与事件 seam；projector 本身不 import 全局单例。
- [x] 启动扫描 Session、long-task、Cron、legacy Runs，随后合并 live registry/external runtime。
- [x] 模拟崩溃前最后状态 running、磁盘已 terminal，重启对账后必须 terminal。
- [x] 单个来源 throw 时保留其他来源并产生局部错误。
- [x] 事件重放/乱序/重复测试。

## T4 — 动作路由

**Files:**
- Create: `task-inbox-actions.ts` + tests
- Reuse: coordinator、agent bridge、automation service、background managers

- [x] renderer 只传 taskKey/action/expectedRevision。
- [x] 路由 Mimi cancel/pause/resume/retry/verify；复用 coordinator 的状态机。
- [x] 路由 automation pause/resume/run-now，明确它控制 schedule，不冒充执行 Session cancel。
- [x] 仅在 live source 能力存在时开放 Session/subagent/background cancel。
- [x] legacy Run 返回 `unavailable`，不修改磁盘 snapshot。
- [x] stale revision、重复 cancel、来源消失与 worker 断线都返回结构化结果。

## T5 — IPC / preload

**Files:**
- Create: `task-inbox-ipc.ts`
- Modify: `packages/desktop/src/preload/index.ts`, `types.d.ts`
- Test: IPC validation/ownership tests

- [x] list/get/act/onChanged API 做枚举、长度、分页上限校验。
- [x] 窗口销毁后解除订阅；不允许 renderer 注入 sessionId/cwd/command。
- [x] snapshot/version 协议可处理 missed event，通过重新拉取收敛。

## T6 — 任务中心页面

**Files:**
- Create: `packages/desktop/src/renderer/task-inbox/*`
- Modify: `PageRegistry`, navigation, i18n
- Test: reducer/filter/action UI tests

- [x] 四组默认排序：等待、运行、失败、完成。
- [x] 来源/项目/状态筛选与搜索；空态、局部错误、stale 状态。
- [x] 根据 capabilities 渲染动作，取消/重试沿用确认对话框。
- [x] 打开原 Session/Mimi/automation/legacy Run 的导航测试。
- [x] 键盘导航与无障碍名称覆盖。

## T7 — Mimi 读模型接入

**Files:**
- Modify: Mimi task query/provider seam
- Test: Mimi task view parity tests

- [x] Mimi 的任务查询读取 projector，不再单独只查 long-task ledger。
- [x] 查询输出与任务中心按 taskKey 一致，不泄漏后台内部字段。
- [x] projector 不可用时降级到现有 long-task 查询。

## T8 — 集成、性能与灰度

- [x] 真实 Electron + 生产 IPC：从隔离 profile 的权威文件聚合 Session、Mimi、自动化、子 Agent、external runtime 与历史 Run；验证生命周期更新。
- [x] 真实 Electron：持久化运行中的后台任务后强制结束 app，重启对账标记 interrupted；已完成的持久子会话仍可打开原始对话。
- [x] 压测 2,000 终态 + 50 活跃记录，列表/筛选无明显卡顿。
- [x] 内部验证后 `taskInboxV1` 默认开启；显式关闭隐藏入口并禁止查询与控制。
- [x] 全仓门禁与 desktop build/typecheck 全绿。

## Definition of Done

- [x] 读模型可删可重建，任何失败不改变权威任务数据。
- [x] 同一逻辑任务不重复成卡，重启/乱序/重放测试全绿。
- [x] 所有动作都有权威状态二次校验且不会由 renderer 指定真实目标。
- [x] 用户可从任意卡片回到来源，等待处理项不再藏在五个入口。

## 2026-10-08 验收依据

- `bun run typecheck`：全部 12 个 workspace 类型检查通过；`bun run --cwd packages/desktop build` 通过。
- `bun run lint:baseline`：0 errors / 105 个既有 warnings，无新增；engine-bypass 和 workflow-test-paths guards 通过。
- Task inbox 模型、持久化、来源、动作、IPC、Mimi 查询和 UI 回归测试通过，包含 external-tail 只读状态、不同历史 Run 保留和原始子会话导航。
- `bun run --cwd packages/desktop test:e2e:task-inbox`：真实 Electron 渲染器验收，使用明确的 IPC fixture，覆盖 2,050 条记录、四组、来源/搜索筛选、局部错误、键盘确认、实时刷新、原 Run 详情及 1280/820/390 宽度。
- `bun run --cwd packages/desktop test:e2e:task-inbox-sources`：隔离 profile 下真实权威文件和生产 IPC，覆盖自动化/Mimi 控制、旧 revision/额外目标字段拒绝、真实 Main 后台 Shell 取消及进程结束、子会话原始 transcript 重开、0600 projection、正常重启及 SIGKILL 后恢复。
- 上述用受控本地数据验证任务中心的聚合、控制与恢复；不把登录真实 Codex/Claude 账号或真实模型执行视为已验证。聊天完成回执继续由既有 coordinator 管理。

实现细节：分页持有同一权威快照，实时版本在当前分页结束后再刷新，避免高频更新导致列表永远加载；运行来源和控制来源分离，外部 CLI 观察任务不获得取消能力；legacy Run 仅在明确 runId 相同时合并主卡，不吞掉同一 Session 的其他历史执行。
