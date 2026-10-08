# 模型请求诊断内容开关

开发运行与 `--debug` 的 session recorder 默认仅记录模型调用元数据，包括 provider、model、
消息/工具数量、请求 ID、时长、usage 和终止原因。`llm.request`、`llm.response`、
`llm.error` 标记 `contentRecorded: false`，不复制 system prompt、messages、工具定义、
回答正文、工具调用参数或原始错误内容。

确需检查模型内容时，在原本启用 recorder 的开发运行中显式设置：

```sh
CODE_SHELL_DEV=1 CODE_SHELL_RECORD_MODEL_CONTENT=1 bun run dev:tui
```

仅精确值 `1` 启用内容记录；该开关不会独自启用 recorder，也不覆盖
`CODE_SHELL_VERBOSE_LOG=0`。内容记录启用时，上述模型事件标记 `contentRecorded: true`。
它仍记录在 provider 转换之前，不能充当实际 HTTP request snapshot 或历史请求重放证据。

这项开关只控制模型 request/response/error 的诊断正文。既有工具事件、UI 时间线与会话
transcript 的保存规则保持不变；工具输入输出和任务正文仍可能出现在这些记录中。
调用方已有的图片及敏感工具结果过滤继续有效，但显式内容诊断不承诺去除所有秘密或个人信息。

单独测试通过子进程读取真实 JSONL：开发默认、debug、错误开关值均不含合成秘密；显式
启用才包含声明范围的内容；禁用 recorder 时没有文件。完整 Phase D 仍需实现 Session
持久 HMAC key、实际 provider projection 边界和 transcript 锚点，不因这项前置改动完成。
