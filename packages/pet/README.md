# @cjhyy/code-shell-pet

CodeShell 的 Mimi（项目工作状态助理 / 桌面 Pet）领域能力包。它只依赖
`@cjhyy/code-shell-core/extension`，由宿主显式加载，不把 Pet 字面量和产品规则重新写回
core。

## 为什么单独成包

Mimi 与普通 Work Session 的职责不同：

- Mimi 负责澄清、汇总、路由和跨 Workspace 协调；
- Work Session 负责读文件、运行工具和完成执行任务；
- Desktop 负责窗口、导航、磁盘会话目录和具体 UI。

因此 Pet 包只拥有可跨宿主复用的领域规则和投影协议。Electron 窗口、React 组件、磁盘目录
扫描等宿主能力留在 `packages/desktop`；通用引擎、工具系统和协议生命周期留在
`packages/core`。

## 模块边界

| 模块                                 | 职责                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `capability.ts`                      | 唯一组合根：注册行为 profile、DelegateWork、投影 observer 和参数校验 |
| `profile.ts`                         | Mimi 的系统边界、允许工具和单轮委托服务                              |
| `delegation.ts` / `delegate-work.ts` | Workspace、可复用 Session 与结构化委托工具                         |
| `run-params.ts`                      | 宿主输入的有界校验、规范化和 fail-closed 快照                        |
| `team.ts`                            | 历史兼容的数字人团队纯数据契约；Pet runtime 不消费          |
| `session-index.ts`                   | Work Session 的纯状态机与安全摘要                                    |
| `pending-decision-index.ts`          | 跨 Session 待决策读模型，不持有 resolver 或原始问题正文              |
| `projection-extension.ts`            | 把 core 的通用生命周期事件投影为 Pet snapshot/delta                  |
| `protocol.ts` / `types.ts`           | Pet 专属 wire shape 和领域类型                                       |
| `long-task.ts`                       | 长程任务状态机、事件协议、恢复提示和有界经理上下文                   |

这种拆分让状态机、输入边界和协议适配可以分别测试，也让 Desktop 以后更换呈现方式时不必改
Mimi 的安全规则。

## 公共入口

Pet 保持为一个 npm 包，不把 projection 和能力工厂继续拆成多个独立发布单元。新代码
应按职责使用两个最小子入口：

```ts
import { createPetCapability } from "@cjhyy/code-shell-pet/capability";
import {
  PET_PROJECTION_DELTA_METHOD,
  type PetProjectionDelta,
  type PetProjectionSnapshotResult,
} from "@cjhyy/code-shell-pet/protocol";
```

| 入口                               | 稳定职责                               | 不包含                                        |
| ---------------------------------- | -------------------------------------- | --------------------------------------------- |
| `@cjhyy/code-shell-pet/capability` | 宿主组合用的 `createPetCapability`     | prompt、工具实现、状态机                      |
| `@cjhyy/code-shell-pet/protocol`   | snapshot/delta 方法名和投影 wire types | `SessionIndex`、pending 状态机、observer 实现 |
| `@cjhyy/code-shell-pet/team`       | 仅历史兼容；新消费方应使用 Desktop 共享契约 | Pet runtime 或 core 扩展逻辑                  |

根入口 `@cjhyy/code-shell-pet` 为现有 Desktop 和动态 capability loader 保持兼容；它不会被
移除，但新消费方不应为了一个协议类型或团队 parser 依赖整个兼容 barrel。包不提供通配
deep import，未列出的源码模块均为内部实现。

## 必须保持的约束

- Mimi 不能获得 Workspace 执行工具；执行工作只能通过 `DelegateWork`。
- Workspace 和可复用 Session 必须来自宿主本轮提供的闭集。
- Pet 不接收、保存或路由数字人 / 数字人团队 id；数字人工作归项目 Session。
- `pet` Session 不得出现在普通 Work Session 列表或待决策列表。
- 投影不得包含 resolver、工具参数、原始 AskUser 正文、命令或凭证。
- 畸形宿主输入必须隐藏委托能力或返回错误，不能降级为不受限执行。
- Pet 包不得运行时依赖 Desktop、TUI、Server、Web 或其他产品包。
- `DelegateWork` 的启动回执不等于完成；只有真实 Work Session 终态才能关闭长程任务。

## 长程任务宿主契约

`long-task.ts` 只定义可移植的领域状态机。Desktop 当前负责把它接到真实运行时：

- 每次委派先原子写入 `pet/long-tasks.json`，再启动 Work Session；
- Work Session 使用 core Goal 模式持续执行，Pet 不复制第二套执行循环；
- 顶层 stream event 提供 checkpoint 和可信的 `goal_progress(met/exhausted)` 终态，Pet projection 提供待审批/断线状态；
- 暂停会持久化 Goal 的 paused 状态并停止当前 turn，恢复/重试继续同一 durable Session；
- 进程重启后，未观察到终态的任务进入 `interrupted`，用户可从原 Session 恢复；
- 终态先写入去重的工作记忆，再确认交付；中途崩溃会在启动时安全重放；
- 每个 Mimi turn 只注入有界 `longTasks` 摘要，不回灌完整 transcript 或工具参数。

## 验证

```bash
bun test packages/pet/src
bun run --cwd packages/pet build
bunx eslint packages/pet/src --max-warnings=0
```

`build` 会先清空 `dist/`，避免删除或重命名源码后把陈旧产物发布出去。
