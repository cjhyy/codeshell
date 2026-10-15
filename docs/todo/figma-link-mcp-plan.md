# Figma Link：官方 MCP 接入记录

2026-10-15：按用户明确要求，将已跑通的注册名称方案接入 Figma Link。
产品合同与使用方式见 [Figma Link](../figma-link.md)。无需兼容旧版摘要。

## 本次实现

- Figma 一个入口分别管理 API 和官方 MCP，保留独立账号、授权与状态。
- MCP discovery/DCR/PKCE、Host 保存、重启复用、自动刷新、轮换及精确断开。
- 只在语义上下文、Make 源码、Code Connect、动画等任务需要时调用 MCP；原始节点、
  导出、填充素材和评论继续走 API，文件默认浅层读取。
- 连接只执行工具发现与账号验证；读取完整节点或源码必须由实际任务触发。
- Host 专用执行链，不向 Worker 返回 Figma MCP token，不暴露通用写入工具。
- 完整 MCP 工具/资源 envelope、分页、8 MiB 预算、取消和授权变更门禁。
- Make 清单后按资源 URI 读取；API 与 MCP 聊天授权恢复按原动作/参数绑定。

## 实测来源与注册名称

最初以 `client_name: CodeShell` 动态注册收到 403；仅改为 `Codex` 后收到 200。
用户在官方页面手动授权后，生产 SDK/authenticated fetch 成功初始化；实际 initialize
名称仍为 CodeShell。发现 45 项工具，对原 Design 文件显式 `0:1` 执行 `get_metadata`
返回 138,003 UTF-8 字节的真实 XML。证据仅保存 hash、字节数和成功标记。

[首次试连](figma-mcp-live-validation-2026-10-15.json)、
[名称对照及真实读取](figma-mcp-name-comparison-2026-10-15.json)。

本次按用户认可的方案仅覆盖可信 Figma profile 的注册名称；不复制任何其他客户端的
凭据、client ID 或登录状态。该名称行为不是 CodeShell 已获得正式 Catalog 准入的声明。
官方注册策略变化仍可能影响可用性。
[官方注册策略说明](https://forum.figma.com/report-a-problem-6/figma-s-approach-breaks-the-core-promise-of-mcp-52507)。

## 后续验收

真实账号此前已通过 OAuth、工具发现和 Design metadata 读取；受控回归验证保存/刷新与
产品链路。真实 Make 源码、设计上下文、动画、Code Connect 及各账号计划/席位仍按实际资源
验收。本次不启用画布写入、生成插件或 shader 工作流，也不把本地退出误报为上游已吊销。

API 的新文件范围仍由原 Link 服务管理；MCP 新授权不能自行扩大 API grant。服务端账号
owner 绑定与无重复上游 OAuth 的文件范围扩展属于独立协议工作，不改变本次凭据边界。
