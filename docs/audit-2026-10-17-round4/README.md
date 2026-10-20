# CodeShell 从源码重新审查（2026-10-17，第四批 checkpoint）

本批确认并记录 **7 项：5 P2、2 P3**。仅新增审查报告、复现与原始收据，未修产品源码。完整条件、源码位置、预期/实际、影响、建议与验证边界见分报告；结构化入口 [findings.json](findings.json)。

冻结基线：`4ee32f28f78b8315112cca77cfc22b2f2f80ced6`。任务分支：`codex/audit/context-round4-20261017`。刷新 origin 后，从当时已包含最新 origin/main 的本地 main 创建；沿用本聊天独立 worktree，主目录既有改动保留。整合前另一任务已更新本地 main，源码基线和首次测试仍保持原值；[整合范围记录](integration-context.md) 单列并发变化及静态核对，未冒称对新 main 重跑。本批重新读当时当前源码，旧报告仅用于去重，不能直接将 [10-16](../audit-2026-10-16/README.md)、[10-17](../audit-2026-10-17/README.md)、[第三批](../audit-2026-10-17-round3/README.md) 的历史数量相加为当前剩余问题数。

| 编号 | 优先级 | 问题 | 详情 |
| --- | --- | --- | --- |
| CTX-1 | P2 | Fallback snip切掉已保留tool call的结果 | [context.md](context.md) |
| CTX-2 | P2 | 摘要转换丢失结构化tool_result中的文字 | [context.md](context.md) |
| SET-01 | P2 | user单字段保存遮蔽YAML中的其他配置 | [settings.md](settings.md) |
| SET-02 | P3 | Config接受错误类型并落盘，后续settings读取失败 | [settings.md](settings.md) |
| CODING-R4-01 | P2 | LSP Definition/References把编码URI当文件路径 | [coding.md](coding.md) |
| CODING-R4-02 | P2 | LSP重复diagnostics未同步已打开文件的编辑 | [coding.md](coding.md) |
| LOG-R4-01 | P3 | 日志轮转按bucket前缀删除最近engine历史 | [root.md](root.md) |

[验证汇总](validation.json)：**6 个首次完整成功 guarded shard，23 pass / 114 expect / 0 fail、skip**。共享日志只计一次。另 **2 组首次 fixture 失败独立保留并跳过**，没有修支架、重试或换方式：CLI 在产品导入前因 readonly namespace 赋值失败；dev recorder 在事件写入前因临时路径字符串控制失败。这两组不支持确认 bug、不计入成功数量。

当前错误行为断言通过只表示可复现，**所有确认项均未修复**。Context 为真实 manager/TurnLoop 与 fake model/summarizer；Settings 为真实 Config/manager 与自有 YAML/JSON；LSP 为真实 tool/manager 与内存 client，官方3.17 didOpen合同经主审在线核对；日志维护只操作自有 tmp。没有真实模型、语言服务器、MCP、账户、平台发送、Ink/PTY/Electron/Host启动或跨平台验证。

三份只读交叉复核：[Settings审Context/Coding](quality-settings.md)、[Coding审Settings/Root](quality-coding.md)、[Context审Coding/Root](quality-context.md)。它们未新增测试。最终 [证据哈希](evidence-index.json)、[源码哈希](source-manifest.json)、[材料质量记录](quality-root.md)、[候选与跳过](candidates-and-skips.md)、[覆盖范围](coverage.md)、[包文件清单](inventory.json) 单独保留。没有全仓 build/typecheck/lint/测试通过声明。

**本批只是持续审查的一个 checkpoint，全仓目标仍在进行。** 当前报告记录已证实的问题和未完成方向，独立 Panel Apps 仓库未做全仓审查。
