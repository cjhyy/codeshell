# 外部运行时自动记忆：2026-10-26

## 支持范围

外部会话完成一次持久化的逻辑提交后，异步运行自动记忆提取和会话摘要。复用 Core `MemoryOrchestrator`，保留已有提取数量、写入决策、手动记忆保护、项目/全局分层和摘要格式，不把自动记忆写进 portable profile。

| 设置/运行时                     | 本轮行为                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 显式 `memories.extractionModel` | 使用指定 API 文本连接，优先于后台模型。                                                                                                          |
| 显式 `defaults.auxText`         | 使用指定 API 文本连接。                                                                                                                          |
| 留空，Claude Code               | 使用会话实际报告的模型和 CLI 认证/项目配置，发起独立、无工具、无历史的文本请求。未报告实际模型时保留配置模型或 CLI default，不编造具体模型身份。 |
| 留空，Codex                     | 明确记录不支持当前无工具记忆请求；不启动完整 Agent，不回退到默认 API 账号。用户可显式选择 API 辅助连接。                                         |
| 显式连接失效                    | 记录失败，不静默选择其他连接或账号。                                                                                                             |

仅在至少 8 条用户/助手消息、正常完成、输出完整、持久会话且项目可信时调度。`autoExtract:false` 保持已有语义：不提取长期记忆，但仍可生成会话摘要。本轮不新增自动 Dream 的 CLI 工具循环，也不改变外部会话的记忆回注策略；现有手动 Dream、Pet 后台摘要仍有自己的调用路径。

## 隔离与归属

- Claude 使用独立进程、`--safe-mode`、空内置工具集、通配工具拒绝、严格 MCP、单回合和不持久化会话。没有前台 thread/session ID、resume/continue 或 Host MCP 配置。保留可信的原项目 cwd 以维持项目级认证/提供商配置解析；私有提示目录和文件独立于项目，并在所有退出路径清理。
- `--safe-mode` 保留认证、模型与权限配置，排除用户/项目的指令、工具定制和非管理员 hooks。管理员策略及其 hooks 仍有效。旧 CLI 不支持必要参数时失败，不降级到完整 Agent。
- 每个业务会话只保留最新待办；新回合、替换、停止、关闭和信任撤销会取消旧任务。后台有独立期限和控制器，不借用已经结束的前台工具权限 lease。
- 完成时冻结文本快照、run ID、项目/profile、目录 incarnation 和 accounting owner。模型返回后与每次持久化之前重新核对，过期结果不能覆盖新记忆。ephemeral 会话不提供持久记忆快照。
- 模型调用和失败事件归属原会话/运行的执行观测。API 使用正常账本；CLI 每次辅助调用单独记录 receipt，费用/未知用量保持 unknown，不套用 API 单价。关闭采集期间开始的 CLI 请求不会在重新开启后补采正文。
- 保留 3,072/1,024 的记忆输出预算；CLI/API 的截断、错误或工具尝试不会转成可保存的 JSON。取消即使遇到迟到的自定义 transport，也会释放队列，并由写入前的归属检查拒绝迟到结果。

## Codex 的准确限制

已核对本机 Codex CLI 0.162.0 的稳定/实验 app-server 类型、CLI 帮助和官方配置契约。`ephemeral`、`outputSchema`、只读 sandbox 或空 `dynamicTools` 都不等于禁止全部工具；当前没有可验证的全工具禁用入口。因此本轮只启用 Codex 的显式 API 辅助路径，没有声称 Codex CLI 已实现原生无工具辅助推理。

依据：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)、[OpenAI 配置 Schema](https://developers.openai.com/codex/config-schema.json)、[Claude CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)、[Claude 设置优先级](https://code.claude.com/docs/en/settings#settings-precedence)。Claude 2.1.310 的本机源码也确认 safe-mode 的 hooks 限制与正常认证配置读取分别处理；测试不以提示词约束代替运行时工具禁用。

## 验证与交付

使用隔离 HOME 的 guarded tests 和本地假 CLI 子进程；没有请求真实提供商、使用真实账号推理或启动付费评测。覆盖实际模型/默认回退、项目配置 cwd、私有提示清理、错误/工具/截断/重复终态、取消与后代进程清理、精确 API 路由、队列合并、设置/归属变化、ephemeral 和前台生命周期。

最终组合 guarded tests：29 个文件，534 通过、0 失败、0 跳过。`bun run typecheck` 完成完整构建及 14 个 workspace 的检查；最后的后台清理改动另通过 Desktop 类型检查。`bun run lint` 为 0 errors / 99 warnings，新增代码的定向 lint、格式与 diff 检查通过。模型适配、归属保护、路由和配置边界分别经过交叉只读复核。

源码位于任务分支 `codex/desktop/external-runtime-memory`，尚未合并、推送或更新已安装应用。本地验证日志位于当前工作区 `.code-shell/external-memory-validation/`，不进入 Git。
