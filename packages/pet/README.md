# @cjhyy/code-shell-pet

CodeShell 的 Mimi（数字人经理 / 桌面 Pet）领域能力包。它只依赖
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
| `delegation.ts` / `delegate-work.ts` | Workspace、可复用 Session、数字人闭集与结构化委托工具                |
| `run-params.ts`                      | 宿主输入的有界校验、规范化和 fail-closed 快照                        |
| `team.ts`                            | 可持久化数字人团队的纯数据契约                                       |
| `session-index.ts`                   | Work Session 的纯状态机与安全摘要                                    |
| `pending-decision-index.ts`          | 跨 Session 待决策读模型，不持有 resolver 或原始问题正文              |
| `projection-extension.ts`            | 把 core 的通用生命周期事件投影为 Pet snapshot/delta                  |
| `protocol.ts` / `types.ts`           | Pet 专属 wire shape 和领域类型                                       |

这种拆分让状态机、输入边界和协议适配可以分别测试，也让 Desktop 以后更换呈现方式时不必改
Mimi 的安全规则。

## 公共入口

Pet 保持为一个 npm 包，不把 projection、团队和能力工厂继续拆成多个独立发布单元。新代码
应按职责使用三个最小子入口：

```ts
import { createPetCapability } from "@cjhyy/code-shell-pet/capability";
import {
  PET_PROJECTION_DELTA_METHOD,
  type PetProjectionDelta,
  type PetProjectionSnapshotResult,
} from "@cjhyy/code-shell-pet/protocol";
import { parseDigitalHumanTeam, type DigitalHumanTeam } from "@cjhyy/code-shell-pet/team";
```

| 入口                               | 稳定职责                               | 不包含                                        |
| ---------------------------------- | -------------------------------------- | --------------------------------------------- |
| `@cjhyy/code-shell-pet/capability` | 宿主组合用的 `createPetCapability`     | prompt、工具实现、状态机                      |
| `@cjhyy/code-shell-pet/protocol`   | snapshot/delta 方法名和投影 wire types | `SessionIndex`、pending 状态机、observer 实现 |
| `@cjhyy/code-shell-pet/team`       | 数字人团队类型、id 规则和 parser       | Pet runtime 或 core 扩展逻辑                  |

根入口 `@cjhyy/code-shell-pet` 为现有 Desktop 和动态 capability loader 保持兼容；它不会被
移除，但新消费方不应为了一个协议类型或团队 parser 依赖整个兼容 barrel。包不提供通配
deep import，未列出的源码模块均为内部实现。

## 必须保持的约束

- Mimi 不能获得 Workspace 执行工具；执行工作只能通过 `DelegateWork`。
- Workspace、可复用 Session 和数字人 id 必须来自宿主本轮提供的闭集。
- `pet` Session 不得出现在普通 Work Session 列表或待决策列表。
- 投影不得包含 resolver、工具参数、原始 AskUser 正文、命令或凭证。
- 畸形宿主输入必须隐藏委托能力或返回错误，不能降级为不受限执行。
- Pet 包不得运行时依赖 Desktop、TUI、Server、Web 或其他产品包。

## 验证

```bash
bun test packages/pet/src
bun run --cwd packages/pet build
bunx eslint packages/pet/src --max-warnings=0
```

`build` 会先清空 `dist/`，避免删除或重命名源码后把陈旧产物发布出去。
