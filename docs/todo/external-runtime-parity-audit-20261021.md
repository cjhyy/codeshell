# 外部运行时能力与可靠性核对

核对日期：2026-10-21。基线：`origin/main eaa5e2d6f`，修复分支：`codex/desktop/external-goal-background-wait`。

范围为 Desktop 外部 Codex / Claude Code 的启动、工具桥、后台任务、Goal、权限、Profile、停止、恢复、界面和用量。结论是：基本交互和持久化已经接通，但仍有多处生命周期和上下文漏接，不能视为与原生 Engine 能力等价。下列“本地修复”仅指本分支源码，当前运行的应用没有替换或重启。

## 本次循环问题

`s-mvhj4des-245864a3` 在 CC 方案任务 `cc-nvridh7f` 仍运行时，分别于 11:09:05、11:09:29、11:10:36 自动注入“继续处理尚未完成的目标”。时间为 Asia/Singapore。后台完成通知已有接线，但外部 Goal 循环没有查询运行中的有限任务，每次 final 后立即继续。

本分支补齐：按 Session 查询 `backgroundJobRegistry`；没有待消费结果而仍有有限任务时，把 Goal 持久化为 waiting，发布 `background_wait`，结束本次提交；完成、失败或取消通知到达后接续。已排队结果优先消费。等待中的 Stop 会暂停持久 Goal，结果保留到明确恢复；重新激活使用 goalId/revision 围栏，不能覆盖同时发生的编辑。等待持久化失败会报告错误，不冒充已进入等待。

## 需要优先修复的缺陷

P1 表示可能挂住运行、使停止失效或使实际授权与界面选择不符。下表的离线复现使用合成进程和回环服务；源码链路核对不等于真实 GUI / provider 验收。

| 编号 | 优先级 | 缺陷与影响 | 证据 |
| --- | --- | --- | --- |
| E01 | P1 | Codex 已接受回合后，app-server 异常退出不会结束 `turn.done`，会话一直等不到终态。 | [runtime](../../packages/coding/src/external-runtimes/codex/runtime.ts#L219)、[transport](../../packages/coding/src/external-runtimes/codex/app-server-client.ts#L272)；离线进程复现。 |
| E02 | P1 | Codex 已发送 `turn/started`、但 `turn/start` 响应尚未到达时点击 Stop，因尚无保存的 turnId 而直接返回，之后也不补发 interrupt。 | [interrupt](../../packages/coding/src/external-runtimes/codex/runtime.ts#L250)；延迟 RPC 响应的离线复现。 |
| E03 | P1 | Claude `close/interrupt` 只发送 SIGTERM，既不等待退出也不超时升级。忽略信号的进程可在 close 返回后继续存在，回合也仍挂起。 | [Claude lifecycle](../../packages/coding/src/external-runtimes/claude-code/runtime.ts#L223)；忽略 SIGTERM 的离线子进程复现，fixture 最终清理自己的 PID。 |
| E04 | P1 | 新数字人会话的 Profile 只作为名字写进文本，没有传入外部启动接口或 canonical Session。资料授权可能回落到更宽的项目默认 Profile，角色指令和 portable memory 也没有走原生解析链。已存在 Session 的显式 Profile 切换另有持久化路径，不属于此缺陷。 | [首次 Profile](../../packages/desktop/src/main/profiles-service.ts#L379)、[renderer](../../packages/desktop/src/renderer/app/useRunController.ts#L439)、[启动合同](../../packages/desktop/src/renderer/externalRuntimeRun.ts#L18)、[资料授权](../../packages/desktop/src/main/external-runtime-source-context.ts#L37)；完整源码链路。 |
| E05 | P1 | renderer 刷新后，preload 的外部 Session Set 变空；Main 没有重播运行时快照。历史可恢复 busy，但 Stop 会发送给原生 `agent/cancel`，外部 provider 继续运行。 | [内存归属](../../packages/desktop/src/preload/index.ts#L470)、[Stop 路由](../../packages/desktop/src/preload/index.ts#L568)、[本地重播](../../packages/desktop/src/preload/index.ts#L1637)；源码链路，尚无实际 Electron reload 验收。 |
| E06 | P1 | 后台唤醒在串行队列外提前 drain 通知。已有用户提交可排在它前面而拿不到结果；暂停发生在唤醒排队后、真正执行前时，已排队提醒也缺少执行时的暂停重验。 | [wakeForBackgroundWork](../../packages/desktop/src/main/external-runtime-service.ts)；源码时序核对。需把 drain 和当前状态检查放进真正执行的串行槽，拒绝时保留通知。 |
| E07 | P2 | Claude 构造链漏传 `developerInstructions`，Desktop 的 Host 工具、委派和等待指导，以及 renderer 提供的 developer context 都没有到达 CLI。 | [factory](../../packages/coding/src/external-runtimes/session-factory.ts#L209)、[Claude options](../../packages/coding/src/external-runtimes/claude-code/runtime.ts#L26)；真实 factory → 假 CLI 的 argv/stdin 复现。 |
| E08 | P2 | Claude 原生工具未映射 Desktop 的 Plan / permissionMode，也无原生审批回调。CodeShell Host 工具仍有权限检查，但 Claude 自带工具依赖它自己的 CLI 配置。 | [Desktop 映射](../../packages/desktop/src/main/external-runtime-service.ts)、[Claude args](../../packages/coding/src/external-runtimes/claude-code/runtime.ts#L102)；确认参数缺失，未运行真实账号写操作。 |
| E09 | P2 | 浏览器图片观察没有视觉能力配置，因此跳过 image/vision；工具桥又仅返回文本，即使产出 `contentBlocks` 图片也会丢失。附件输入是另一条已存在的链路，不应混同。 | [视觉 gate](../../packages/core/src/tool-system/builtin/browser-tools.ts#L134)、[MCP 回包](../../packages/coding/src/external-runtimes/shared/mcp-bridge.ts#L346)；gate 源码核对，图片丢失已回环复现。 |
| E10 | P2 | Claude promptTokens 未计入缓存读写，和原生 Anthropic 的统计合同不同。例如新输入 20、缓存读 100、缓存写 2，应归一化为 122，却报告 20，影响预算和上下文显示。 | [Claude usage](../../packages/coding/src/external-runtimes/claude-code/event-translator.ts#L228)、[原生归一化](../../packages/core/src/llm/providers/anthropic.ts#L64)；离线事件复现。 |
| E11 | P2 | **已修复（PR #195，`6391683cf`）**：bridge 按线程和请求 ID 跟踪进行中的调用，`notifications/cancelled` 或连接断开会中止该调用的 signal，前台 DriveAgent 随之终止子进程。原问题：只回 202，未关联 AbortController。 | [notification](../../packages/coding/src/external-runtimes/shared/mcp-bridge.ts#L271)、[execute](../../packages/coding/src/external-runtimes/shared/mcp-bridge.ts#L331)；真实回环请求复现。 |
| E12 | P2 | 外部会话 `/compact` 仍发往原生 Engine，没有压缩实际 Codex/Claude thread，可能提示成功却保留原上下文，或因原生 provider 配置报错。 | [renderer](../../packages/desktop/src/renderer/app/useRunController.ts#L1084)、[preload](../../packages/desktop/src/preload/index.ts#L775)、[原生处理](../../packages/core/src/protocol/server.ts#L3213)；源码链路。 |
| E13 | P2 | SessionToolHost 默认建立空 HookRegistry，factory 没有装载 CodeShell 的 settings/plugin 工具 Hook。经过 ToolExecutor 不意味着这些配置的 Hook 已执行；vendor 自己的 Hook 属另一套配置。 | [Host hooks](../../packages/core/src/tool-system/session-tool-host.ts#L234)、[空 registry](../../packages/core/src/hooks/registry.ts#L35)、[factory](../../packages/coding/src/external-runtimes/session-factory.ts#L164)；源码链路。 |
| E14 | P2 | Host Bash 可声明 `background_behavior=wait_for_exit`，但外部服务没有接 `runYield`。本次有限任务查询只覆盖 BackgroundJobRegistry，不包括后台 Shell；它们退出时虽有通知，等待期间仍可能空转。另外返回文案推荐 BashOutput / KillShell / ListShells，但外部 allowlist 未开放这三项。 | [Bash yield](../../packages/core/src/tool-system/builtin/bash.ts#L143)、[背景 Shell 合同](../../packages/core/src/tool-system/builtin/bash.ts#L225)、[工具 allowlist](../../packages/core/src/tool-system/external-tool-exposure.ts)；源码链路。需按明确 wait_for_exit 句柄接线，不能把长期 dev server 全部视为等待条件。 |
| E15 | P3 | Claude `thinking_delta` 没有转换为界面思考事件，对应状态/输出消失。 | [translator](../../packages/coding/src/external-runtimes/claude-code/event-translator.ts#L135)；离线事件复现。 |

## 尚未支持或需要产品决定的能力

- **24 小时托管调度。** 外部工具 allowlist 没有 CronCreate/CronList/CronDelete/Sleep。外部 Goal 默认只允许 12 个 provider 回合、30 分钟；自然语言写“24小时”不会改变配置。每次 start 又重置本轮计数，因此它也不是跨续办的总任务预算。需要单独接通 Host 调度、统一截止时间和任务预算。
- **原生 MCP 工具与资源。** 外部 registry 只组装 BUILTIN_TOOLS + CODING_TOOLS，没有把 CodeShell MCPManager 的工具和按 Run/Profile 的服务器配置接入。`ReadSource` 的 mcp-resource 适配器缺 manager/允许服务器时明确失败；vendor 自有 MCP 不等价于 CodeShell 的连接。LinkAction 的现有连接能力已经接通，不列为缺失。
- **原生 Agent 和 Plan 状态工具。** Agent、EnterPlanMode、ExitPlanMode 是有意排除；DriveAgent 已开放，不能沿用旧文档称其全部不支持。
- **其他 Panel 的直接调用。** Panel.invoke 当前仅允许评审过的求职工具；其他面板可发现/打开，CLI 是不同入口。扩大 invoke 需要逐工具授权评审。
- **外部 provider 的逐请求成本 receipt。** 当前保留 aggregate tokens 和已有 Host 费用，操作账本明确标记 vendor 请求覆盖不足，无法完整归集重试和模型成本。
- **手机冷启动、运行中 steer、reasoning effort。** 手机需要 Desktop 已建立 owner/runtime；外部新输入等待当前 provider 回合结束，不具原生中途 steer；没有显式 effort 参数链。它们是当前能力边界。
- **跨 runtime 重建的后台任务。** 更换外部模型/权限导致重建时，会执行 dropSession 并中止、删除既有后台作业；是否改为业务 Session 生命周期需明确决定。不能为本次修复直接重启正在工作的会话。

## 已存在的能力与验证边界

跨重启 runtime id 落盘和 Codex resume、普通审批 UI、Host 权限 deny、owner 隔离、附件输入、Goal 控制、output journal、基本后台完成通知、已适配的手机输出恢复均已有实现。旧设计稿的“仍未做”清单含过期内容，不能作为现状矩阵。

本次未调用真实 provider、真实外部 CLI、第三方账号，也未重启用户应用。隔离假进程/回环证据测试有 6 项，验证的是当前缺陷可复现，不代表它们已经修复。复现文件保存在本机 `/tmp/codeshell-external-runtime-audit-20261021/protocol-audit.test.ts`，可能随临时目录清理而消失；长期定位依据是上表源码路径和复现条件。

本地后台等待修复及相邻模块验证：

- 根目录 `bun run build` 通过；Desktop `typecheck` 通过。
- guarded Bun shard：447 pass、0 fail、0 skipped，31 个文件，包含 Desktop external-runtime、preload、mobile commands、Core Goal lifecycle 及两种外部 adapter。既有测试通过不排除本次新复现揭示的缺口。
- 变更 TypeScript 文件 ESLint：0 error、1 条既有 prefer-const warning；`git diff --check` 通过。

建议实施顺序：先统一进程终态与 Stop，再补首次 Profile 和 renderer 恢复；随后修后台队列时序、Claude 指令/权限映射，最后推进图像/用量/compact/Hook 与调度能力。每项分别增加对应消费者回归，真实安装包验收单独记录。
