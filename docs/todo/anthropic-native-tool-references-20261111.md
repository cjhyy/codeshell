# Anthropic 原生工具引用（第四步）

- 日期：2026-11-11
- 基线：`origin/main` @ `57fc7413f`
- 范围：在前三步的冻结工具与追加式发现之上，增加 Anthropic Messages 原生引用。
- 当前阶段：前置协议核实及受控探针；真实 token 对照尚未执行，不把文档描述当作实测结果。

## 开工前四问

| 问题                         | 已知事实与验证方式                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 延迟定义是否进入初始上下文？ | Anthropic 文档说明不进入。新增探针比较 search-only、24 个 eager 工具、同一批 deferred 工具的总输入 token；真实结果是启用该路径的门槛。                      |
| OpenRouter 用哪条协议？      | 使用 Messages 的客户端搜索和 `tool_reference`，不依赖 Chat Completions 的透传猜测。既有 Chat 连接继续使用 `CallTool`；原生线路需要明确选择 Anthropic 协议。 |
| 缓存断点放在哪里？           | 只放在最后一个非延迟工具；所有 deferred 定义都不带 `cache_control`，总断点仍不超过四个。                                                                    |
| 换模型后的历史如何恢复？     | 会话保存完整、不可变的 schema 文本及中立的发现标记。只有请求序列化阶段将匹配的内容投影为引用，其他协议直接使用保存的文本。                                  |

## 实现边界

1. 在统一策略里选择 `call-tool` 或 `tool-reference`。原生路径仅用于明确支持的 Anthropic Messages 线路与模型；未知线路保留既有行为。发现模式进入缓存周期身份。
2. 分别冻结 eager 工具和 deferred 目录，跨 run、重启及资格变化保留相同定义和顺序。已保存的空快照同样具有权威性，不在恢复时填洞。
3. `ToolSearch select:` 保留当前完整文本和 24k 预算，给成功输出的 schema 块附加中立发现标记。只有与本周期冻结 deferred 定义一致的块可转换为原生引用。
4. 保留 eager `CallTool`。晚到工具或周期中变化的 schema 仍通过文本与包装调用使用，直到下一次真正的缓存周期重建。原生真实名字调用继续经过当前资格、参数、权限、hook、计划模式与并发检查。
5. 压缩提升、模型切换和协议切换允许重建目录；旧发现结果的降级只使用记录中的原始文本，不从当前注册表重构。资格撤销不改写既有历史投影。
6. 结构化发现结果不能吞掉执行器追加的 guard 或 post-hook 上下文。纯文本调用方及外部工具 Host 保持原有结果契约。
7. 不引入 Anthropic 服务端搜索工具，不启用 OpenRouter 的另一个 `deferred_tools` 会话协议，不升级 API 版本或批量升级 SDK。

## 离线审查补充（实测前）

- 统一连接链路已经按 catalog 的 `protocol: anthropic-style` 选择 Anthropic 客户端，无需新增路由开关或迁移现有 OpenRouter Chat 连接。
- 首版拟限定为已知支持的 Messages 模型，并要求显式 `reasoning.mode: off`；发送 `thinking: {type: "disabled"}`。Sonnet 5 省略该字段会默认启用思考，因此不能用省略代替关闭。其他思考设置保留既有发现方式，不替用户关闭思考。
- 当前 Anthropic 客户端会丢弃签名思考块。首版不把原生引用推广到思考模式，也不把 `CallTool` 回退描述为已经修复了这个既有续写问题。若单次调用覆盖了已冻结原生周期的思考设置，应在发送前明确拒绝，避免悄悄改变历史投影。
- 原生引用匹配须同时检查工具名、schema 摘要及完整原始文本。共享格式函数只处理有序的 `{name, description, inputSchema}`；历史文本被截断或修改后，保留修改后的文本，不用旧标记展开完整 schema。
- deferred 目录不能授予执行资格。运行中的 `rebase()` 当场重建 deferred 快照，纯持久化重建则删除 eager/deferred 两份快照；不能延迟到下一 run 才补目录。
- 原始文本的拼接规则需覆盖跨协议回退；现有 OpenAI 与上下文处理对文本块使用不同的换行拼接方式。测试必须验证完整 schema 及 guard/post-hook 内容都保留下来。

离线探针已通过 20 项测试和真实 Node dry-run；没有读取付费凭据或发送网络请求。真实探针仍等待单独授权，前置问题一尚未通过，生产实现尚未开工。

## 独立验收

- 本地 HTTP fixture 检查实际请求的 `defer_loading`、引用格式、非延迟断点、鉴权和路径，以及流式/非流式一致性。
- Engine 检查三批发现中的 eager/deferred 工具目录与既有消息前缀；同时验证重启、晚到/撤销/变更工具、压缩及跨模型降级。
- 验证没有发现的工具仍不能执行，复杂参数和 post-hook 文本不丢失，组合 golden 保持不变。
- 真实探针只发送合成输入，最多八次请求、每次最多 256 输出 token、预算 2 美元；默认 dry-run，只有明确授权后才读取选定凭据和发起付费请求。
- 没有直连 Anthropic 凭据时，只记录所测 OpenRouter Messages 路线的证据，不声称覆盖直连服务。

## 协议依据

- [Anthropic 自定义工具搜索](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool#custom-tool-search-implementation)
- [工具搜索与提示缓存](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- [工具定义字段](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference#tool-definition-properties)
- [2026-02-17 发布记录：工具搜索无需 beta header](https://platform.claude.com/docs/en/release-notes/overview#february-17-2026)
- [OpenRouter 客户端搜索](https://openrouter.ai/docs/guides/features/server-tools/tool-search#client-side-tool-search)
- [Anthropic Sonnet 5 思考默认值](https://platform.claude.com/docs/en/models/sonnet-5/overview)
- [OpenRouter Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message)

这些链接说明协议契约，不能代替本仓库实现的测试和真实用量记录。
