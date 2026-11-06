# Native 与外部 Runtime 的共享宿主能力

原生 Engine、Claude Code 和 Codex 共用工具策略与后台结果交付规则。外部 CLI
仍拥有自己的模型循环；其适配器负责进程、协议、输入和输出，宿主负责工具授权、
Session 归属及后台结果的保管。

## 工具策略

调用链为：当前 settings/Profile 和宿主上下文 → `prepareToolPolicySnapshot` →
可 JSON 序列化的 `ToolPolicyInputSnapshot` → 纯函数 `resolveToolPolicySnapshot`。

工具所属模块在 `BuiltinToolExposure` 声明 availability、definition rewriter、feature
flag 和外部兼容性。Registry 保存这些声明；Engine 不再维护另一套私有 guard/rewriter
映射。准备层执行可用性检查与 schema 改写，纯函数统一处理 builtin 禁用、工具集合、
MCP server/tool 限制和 Plan Mode。未通过静态过滤的工具不会执行其 guard。

原生 `assembleRunToolDefs` 负责把结果写回每次运行的 `ToolContext`。外部
`SessionToolHost` 在列举、搜索和执行时读取当前配置，并为调用建立独立上下文。
每次调用在 hook 改写、审批结束后再次检查授权，嵌套工具调用沿用同样的限制。

- 项目 builtin `off` 和 Profile 的 Skill/plugin 禁用都在宿主侧执行。
- Host 传入的工具范围、MCP 连接基线与外部审核集合只能继续收窄。
- Workspace 来自 Desktop 与原生运行共用的 Project/Session 解析器；挂载根变化
  会刷新上下文，主根改变要求重新授权的 Runtime，配置或归属读取失败则拒绝。
- 外部可用工具集合不超过同输入的原生可用集合与已审核外部集合的交集。

**工具执行和模型可见性是不同的承诺。** 直接调用和 `ToolSearch` 使用当前策略；
`tools/list` 每次请求也返回当前策略，但外部 CLI 可能缓存列表。会话中禁用工具后，
宿主保证拒绝调用，不能保证模型下一轮立即忘掉工具名称。启动或重建会话时列表正确。

## 外部暴露的审阅边界

`external-tool-exposure.reviewed.json` 是独立、入库审阅的快照。条目包括工具名、
兼容类型、理由、参数约束以及 schema/权限元数据指纹。没有声明、没有审阅记录、
声明或指纹不匹配的工具默认不开放；Registry 替换也必须重新匹配审核记录。

新增宿主工具的步骤是：

1. 在所属 Core/Coding/Host 模块注册实现及兼容声明。
2. 审查权限、宿主归属和参数范围，显式更新快照并检查 diff。
3. 运行快照一致性和相应工具测试。Claude Code/Codex adapter 无需各加一份名单。

快照更新不是 build/test 的副作用。Schema 或 Panel 参数范围扩大必须留下审核 diff。
显式运行 `bun run scripts/update-external-tool-review.ts` 更新，或加 `--check`
只校验；更新后审阅 JSON diff，并运行 Desktop 的完整组合快照测试。
函数实现本身仍需代码审查和行为测试，指纹不会尝试散列编译后的函数源码。
目前的已审阅工具范围和 Panel 动作范围保持不变；四个 Goal 工具仅在宿主提供
版本校验控制器且启用执行模式时开放。原生 Goal 的确认型 handler 不会因此开放。

## 后台结果与续办

`NotificationQueue.claimResults` 保留原始 envelope 的身份、顺序和持久化副本，
返回一次性的 `acknowledge`/`restore`。`BackgroundContinuationController` 统一
检查当前归属、Stop 和 adapter 的额外约束；`BackgroundResultDelivery` 统一处理
确认和恢复。两类 adapter 继续负责各自的串行运行队列和授权解析。

- 未 Stop 时，后台完成自动续办。
- Stop 后，无论是否有 Goal，后台完成都不唤醒，结果留待用户继续；正常用户输入
  或有效的显式 Goal Resume 恢复续办资格。
- 启动进程、记录输入和增加尝试轮数都不代表 provider 已接收。明确的启动确认、
  有效 provider 输出或成功结束才确认结果交付；之前失败则恢复原 envelope。
- 已开始处理后失败不重复投递，避免部分执行被重放。
- 关闭/reset 撤销旧 claim；旧 run 的迟到回调不能消费或恢复新会话的结果。
- 恢复不会重新发布完成通知，启动失败不会触发无休止的自动重试。

这些契约由共享 controller/队列测试、原生 wakeup 测试和两个外部 provider 共用的
服务测试验证。执行测试使用仓库的隔离 runner，不启动真实付费 provider。

## 边界

此共享层不统一模型循环、上下文压缩或 CLI 自身工具。`compact`/`steer` 的现有
能力差异仍由对应入口处理；没有新增通用 Runtime 能力框架。扩展该框架应有具体
消费者，不应把工具授权或后台交付规则再次复制进各 provider adapter。
