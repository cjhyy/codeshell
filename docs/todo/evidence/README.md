# Phase 0-B 实证：Codex MCP thread metadata 可信性

> 环境：`codex-cli 0.145.0`，macOS 15.6.1 arm64，ChatGPT 登录态  
> 日期：2026-07-31

设计稿 §11.3.1 把「Codex app-server 是否在 MCP 请求上提供**可信**的 thread
metadata」列为 Phase 0-B 阻塞性调研项，因为整个共享 bridge 方案（§11.2 + §11.3）
都建立在这个未验证前提上，而它同时决定 §22.7（每 session 一个 bridge）的取舍。

本目录用两个可复现脚本回答了它。**结论：前提成立。**

## 复现

```bash
node docs/todo/evidence/codex-mcp-thread-metadata-probe.mjs   # 主链路
node docs/todo/evidence/codex-mcp-thread-spoof-probe.mjs      # 伪造测试
```

两个脚本都自带 loopback HTTP MCP server（随机端口 + 32 字节 bearer token），
自己拉起 `codex exec` 并指向它，不依赖仓库代码。

## 结论一：`_meta` 携带完整且可信的 thread 身份

`tools/call` 实际收到的 `_meta`：

```json
{
  "threadId": "019fb618-e7fe-7d73-916f-79ede88e0dd2",
  "progressToken": 1,
  "x-codex-turn-metadata": {
    "session_id": "019fb618-e7fe-7d73-916f-79ede88e0dd2",
    "thread_id": "019fb618-e7fe-7d73-916f-79ede88e0dd2",
    "turn_id": "019fb618-e905-7321-bc9d-8c6d4f109312",
    "thread_source": "user",
    "sandbox": "none",
    "workspaces": { "<cwd>": { "latest_git_commit_hash": "…", "has_changes": false } },
    "turn_started_at_unix_ms": 1785466513673,
    "model": "gpt-5.6-sol",
    "reasoning_effort": "xhigh"
  }
}
```

比设计稿预期的更多：除 `threadId` 外还有 `turn_id`（可直接支撑 §13.2 的
「Host Tool 调用继承该 turn 的 abort signal」）和 `workspaces`（可交叉校验 cwd）。

**身份只在 `_meta` 里，不在 HTTP header 里**。收到的 header 只有
`mcp-protocol-version` / `accept` / `authorization`，没有任何 thread/session 字段。
所以 bridge 必须从 JSON-RPC body 的 `_meta` 取，不能寄希望于 header。

## 结论二：模型无法伪造 `_meta.threadId`

§11.3.1 定的判定标准是「由 app-server 自身注入、模型无法通过 tool args 或 prompt
影响」——「字段存在」不算可信。伪造测试给模型一个带 `threadId` 参数的工具，并明确
要求它填入攻击者值：

```
model-supplied args.threadId : "ATTACKER-CONTROLLED-THREAD"
_meta.threadId (app-server)  : 019fb619-95cd-7e43-af6c-1c794793ddd9
MODEL COULD FORGE _meta?     : false
```

两者完全隔离。**判定标准满足。**

## 结论三：`bearer_token_env_var` 是真实且已发布的配置面

设计稿 §11.2 的注入参数得到确认，形式为：

```
-c mcp_servers.<name>.url="http://127.0.0.1:<port>/mcp"
-c mcp_servers.<name>.bearer_token_env_var="CODESHELL_MCP_TOKEN"
```

token 经环境变量传入、不出现在 argv，与 §12.2 的要求一致。`codex mcp list` 也把
`Bearer Token Env Var` 作为一等列展示，说明这不是内部实验字段。

## 踩到的两个坑（实现时会再遇到）

1. **必须支持 SSE 响应**。Codex 发的是
   `accept: text/event-stream, application/json`。只回 `application/json` 时，
   `tools/call` 会被报成 `user cancelled MCP tool call` —— 一个极具误导性的错误，
   看起来像用户拒绝，实际是传输层不匹配。bridge 必须按 `accept` 回 SSE。
2. **非交互 `codex exec` 下 MCP 工具调用默认被审批拒绝**。表现同样是
   "user cancelled MCP tool call"。上面的脚本用
   `--dangerously-bypass-approvals-and-sandbox` 才走通。

   这一点**顺带印证了设计稿 §10.3 / §12.1.1 的核心论点**：Codex 侧的
   approval/bypass 只管 Codex 自己是否愿意发出这次调用，与 CodeShell 是否授权
   完全正交。真实实现里 CodeShell 的 `ToolExecutor` 仍会独立审批，
   Codex 的 bypass 不构成 Host Tool 的信任边界。

## 对方案的影响

- §11.3.1 的阻塞项**解除**，Phase 3 可以排期。
- §22.7（每 session 一个 bridge）**恢复为「暂不采用」**：共享 bridge +
  `_meta.threadId` 路由的前提已验证，不需要退到一 session 一端口。
- §11.3 的 fail-closed 规则全部保留 —— 前提成立不等于可以省掉校验。
  实现仍必须：无 thread ID 拒绝、未注册 thread 拒绝、一个 batch 含多个 thread 拒绝。
- 新增一条实现要求：bridge 必须回 SSE（见坑 1），否则失败会伪装成"用户取消"。

## 未验证 / 超出本次范围

- `item/tool/call`（app-server 的 server→client 反向工具调用，
  `DynamicToolCallParams` 要求顶层 `threadId`+`turnId`）在 0.145.0 中
  **schema 已定义但未接线**：`turn/start` 没有声明动态工具的字段，
  `DynamicToolSpec` 无任何请求类型引用它，`code_mode` feature 仍是
  `under development`。若将来接线，它可以完全取代 HTTP bridge —— 值得跟踪，
  但现在不能依赖。
- 未测多个并发 thread 同时打同一 bridge（§21 验收标准 6）。
  `_meta.threadId` 已证明可信且逐调用携带，并发正确性属于 bridge 自身实现问题。
