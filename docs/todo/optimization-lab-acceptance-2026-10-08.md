# 优化实验室 P1a 交付与验收（2026-10-08）

本轮实现默认关闭的 Desktop 文本实验闭环。自动验证只连接隔离 HOME 下的本地假 HTTP 服务，没有调用真实付费模型，也没有作者真实收益评价。P1b 完整材料导入/编辑/实验室内试用、P2 隔离 Agent 执行/范围化采用/回滚未实现。

## 已交付行为

用户选择受信任的本地项目、单文件 Skill、目标/优化连接和手写样本 JSON，校验并冻结计划；原生对话框展示模型端点、外发材料、额度、执行时间、到期时间和未知上界。确认授权后仍须单独开始。通用聊天/移动端/远程 RPC 无法写授权，renderer 不能自行提供 cwd、确认标记或信任状态。

实验运行原版开发题、一次反思生成最多两个正文候选、开发筛选、固定重复次数的原版/候选交错保留题。目标模型只接收该题输入和冻结正文；优化器只接收开发反馈。必要人工评分缺失或不确定时停在检查点，导入只保存不可变评分，不自动继续。更正显式引用旧记录，已使用的反馈 hash 保持固定；最终更正仅生成新报告，不发 HTTP。

每个实际 HTTP 尝试先落 durable reserve/dispatch，SDK 重试同样计量。未知结果保留额度，续期不归零；搜索不能消费最终配对预留。短文件锁与 generation 租约隔离执行者，过期接管后旧 owner 无法迟到写。缺失、损坏、回滚账本失败关闭；仅未完整尾行可留证修复，已落盘但 head 尚未前移可向前恢复。

报告给出正文 diff、理由/来源、开发过拟合提示、逐题配对、故障/回归分类、计划分母、reported/reserved/unknown 和限制。已知开发回归与关键硬失败不能被保留集改善掩盖；analysis-only、未评分、未知实际模型/usage、不可比较缓存保持未知。报告内容寻址且不覆写。候选不写进 Skill 扫描根，不改 Memory/dream，报告 `adoptionEligible=false`。

关闭页面不停止 worker。退出应用/控制父进程管道关闭时 worker 退出；已 dispatch 的步骤恢复为 unknown，不自动重放。中断须显式继续，额度不足须新授权；用户 Stop/failed 是终态。

## 无付费验收映射

| 设计门槛 | 实现/行为验证 |
| --- | --- |
| 样本来源切分、冻结内容校验、权限/路径边界 | `contracts/dataset.test.ts`、`dataset-loader.test.ts`、`contracts/experiment.test.ts`、`store.test.ts` |
| 未授权/到期/撤销/配置错配零请求；严格选中连接 | `ledger.test.ts`、`providers/transport.test.ts`、`controller.test.ts`、Desktop `optimization-lab-ipc.test.ts` |
| 最终预算保护、执行窗口、等待不计时、续期不归零 | `ledger.test.ts`、`controller.test.ts` |
| 多进程竞争、SIGKILL、旧 generation、账本损坏/回滚 | `store.test.ts`、`lease.test.ts`、`ledger.test.ts`、`controller.test.ts` |
| 所有 HTTP、SDK 重试、abort、未知实际模型/usage | `providers/transport.test.ts`（真实 Core SDK + fake fetch） |
| 无 expected/未执行保留题泄漏、一次有限反思 | `controller.test.ts`、`strategy.test.ts`、`candidate.test.ts` |
| 硬失败优先、人工检查点、盲评映射、显式更正 | `assertions.test.ts`、`grading.test.ts`、`controller.test.ts`、`report.test.ts` |
| 分母、成本可比性、保留结论、开发回归否决、确定性 hash | `report.test.ts`、`overfit-hints.test.ts` |
| 默认关闭/user-only/Desktop-only、Core extension 边界 | `tests/optimization-lab-composition.test.ts`、Desktop feature/navigation tests |
| 可信原生确认、项目切换/信任重查、受限文件导入导出 | Desktop Main/preload/page focused tests |
| 页面真实操作、生产 worker、保存/重启、评分、停止 | `packages/desktop/scripts/e2e-optimization-lab.mjs`（Electron + 本地 HTTP） |
| 控制父进程结束时清理 | Core `graceful-shutdown.test.ts`、真实 stdio credentials tests、Electron 中断验收 |

测试文件未写完整路径时，实验引擎路径为 `packages/optimization-lab/src/`。交付记录是实际证据入口；原计划 B 与方案 §14 的未勾清单保留为设计基线，不一键勾选成全部真实验收。

## 实现取舍与后续

- 初期 adapter 为 OpenAI-compatible/OpenRouter/Anthropic 非推理、非流式文本；不支持的推理模型族、tools/images、任意 headers/authCommand/参数预检失败，不借默认连接回退。模型别名必须与真实响应 model 相同，否则配对无效。
- 当前没有保守输入 Token 上界或冻结价格表。Token/费用最坏上界为未知；依赖未知估算的有限阈值拒绝。只将服务端明确回报的美元计为 reported cost，不把字符估算称为账单。
- 凭据内容不入计划/报告。现有凭据存储没有非秘密版本，`credentialRevision=null`；纯凭据轮换允许，模型/端点/有效配置改变必须新计划。
- 候选以独立不可变 JSON artifact 保存，正文包含其中；不额外创建计划示意的 `body.md`，不使用 `SKILL.md` 命名。
- 没有自造 module lifetime 框架：页面关闭保持 worker；stdio 父管道关闭/进程退出停止。通用 AgentModule disposer 仍是后续 Runtime 工作。
- 小样本门槛只支持探索性结论。真实模型实验须对具体冻结计划逐次原生授权；一份值得复看的真实报告再决定投入 P1b/P2。

## 运行方式与验证结果

用户级开启 `featureFlags.optimization_lab=true`，重启 Desktop worker 后进入侧边栏「优化实验室」。选择项目、编辑真实样本、冻结计划、原生确认，再单独开始。开发验证命令：

```sh
bun run typecheck
bun test --timeout 30000 tests packages
bun run lint
bun run lint:baseline
bun run lint:engine-bypass
bun run --cwd packages/desktop build
bun run --cwd packages/desktop predist
bun run --cwd packages/desktop test:e2e:optimization-lab
```

已通过全仓构建/类型检查、Desktop 构建及 183 项集成 focused tests；ESLint 为零错误、105 条既有警告且 baseline guard 通过。真实 Electron 首轮 27 次本地 HTTP 覆盖完整 13 请求实验、三个人工评分阶段、原生取消/撤销、在途停止、报告重开和源 Skill 不变。最终补充验收与 CI 结果在合并前更新；无真实模型实验与真实收益结论。
