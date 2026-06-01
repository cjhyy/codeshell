# Core 文档审计 Manifest

- 生成时间：2026-06-02T00:15:26
- 说明：用于核验本次 core 阅读文档实际存在、大小、哈希、章节和查看方式。

## 文件校验

| 文件 | 行数 | 字节 | SHA256 |
|---|---:|---:|---|
| `docs/core-deep-dive.md` | 2682 | 106907 | `00e10b2e8ce32168167c1aaf7f23179cdb3de2904a09b66f5afb58a28a56fe4b` |
| `docs/core-module-reference.md` | 628 | 17256 | `6c39673b199d39d1be11cfeeb493b383acd595f07840eaa06db9240489bbe110` |
| `docs/core-complete-review.md` | 3326 | 124411 | `26814d36da014eb89b7952d251f442842aaa9a2e3ef7277050100e5f8bab9cc9` |

## 章节索引

### `docs/core-deep-dive.md`

- L6: ## 1. 总览
- L51: ## 2. 公开入口与包导出
- L147: ## 3. 主运行链路：从调用 `Engine.run()` 到模型与工具循环
- L277: ## 4. Engine 模块
- L384: ## 5. Turn Loop 模块
- L490: ## 6. Run 模块：Runner、Manager、Queue、Store、Approval
- L607: ## 7. Protocol 模块：Server、Client、Transport、Session
- L739: ## 8. LLM 模块：Provider、ModelPool、Capability、Streaming
- L886: ## 9. Tool System 模块：Registry、Executor、Permission、MCP、Guards
- L1035: ## 10. Context 模块：上下文管理、压缩、工具结果预算与存储
- L1120: ## 11. Session 模块：会话、Transcript、Memory、File History
- L1212: ## 12. Settings 模块：Schema、Manager、作用域合并
- L1292: ## 13. Prompt 模块：Composer、Section、Instruction Scanner
- L1344: ## 14. Hooks 与 Plugins 模块
- L1464: ## 15. Skills 模块
- L1517: ## 16. Services 模块：Memory、OAuth、Notifier、Analytics、Diagnostics
- L1558: ## 17. Logging 模块
- L1580: ## 18. Git / LSP / Runtime / Utils 支撑模块
- L1631: ## 19. 状态与成本统计模块
- L1670: ## 20. 已发现的潜在 bug / 风险清单
- L1770: ## 21. 推荐后续阅读顺序
- L1847: ## 22. 本文档覆盖范围和限制
- L1860: ## 23. 源码证据索引与链路核验表
- L2056: ## 24. Builtin Tools 详细模块文档
- L2135: ## 25. Sandbox 详细模块文档
- L2207: ## 26. Automation Scheduler 详细模块文档
- L2265: ## 27. Arena 子系统详细模块文档
- L2350: ## 28. LLM Capability Rules 详细模块文档
- L2427: ## 29. RunStore / FileHistory / SessionManager 风险源码细化
- L2541: ## 30. 端到端链路核验图与 core 文件覆盖矩阵

### `docs/core-module-reference.md`

- L5: ## 1. 顶层入口 / root
- L46: ## 2. Engine 模块
- L123: ## 3. Protocol 模块
- L176: ## 4. Run 模块
- L241: ## 5. LLM 模块
- L300: ## 6. Tool System 模块
- L354: ## 7. Builtin Tools 模块
- L380: ## 8. Context 模块
- L418: ## 9. Session 模块
- L455: ## 10. Settings / Prompt / Hooks / Plugins / Skills
- L493: ## 11. Automation 模块
- L529: ## 12. Arena 模块
- L569: ## 13. Git / LSP / Runtime / Services / Logging / Utils
- L607: ## 14. 总风险清单压缩版

### `docs/core-complete-review.md`

- L14: ## 1. 总览
- L59: ## 2. 公开入口与包导出
- L155: ## 3. 主运行链路：从调用 `Engine.run()` 到模型与工具循环
- L285: ## 4. Engine 模块
- L392: ## 5. Turn Loop 模块
- L498: ## 6. Run 模块：Runner、Manager、Queue、Store、Approval
- L615: ## 7. Protocol 模块：Server、Client、Transport、Session
- L747: ## 8. LLM 模块：Provider、ModelPool、Capability、Streaming
- L894: ## 9. Tool System 模块：Registry、Executor、Permission、MCP、Guards
- L1043: ## 10. Context 模块：上下文管理、压缩、工具结果预算与存储
- L1128: ## 11. Session 模块：会话、Transcript、Memory、File History
- L1220: ## 12. Settings 模块：Schema、Manager、作用域合并
- L1300: ## 13. Prompt 模块：Composer、Section、Instruction Scanner
- L1352: ## 14. Hooks 与 Plugins 模块
- L1472: ## 15. Skills 模块
- L1525: ## 16. Services 模块：Memory、OAuth、Notifier、Analytics、Diagnostics
- L1566: ## 17. Logging 模块
- L1588: ## 18. Git / LSP / Runtime / Utils 支撑模块
- L1639: ## 19. 状态与成本统计模块
- L1678: ## 20. 已发现的潜在 bug / 风险清单
- L1778: ## 21. 推荐后续阅读顺序
- L1855: ## 22. 本文档覆盖范围和限制
- L1868: ## 23. 源码证据索引与链路核验表
- L2064: ## 24. Builtin Tools 详细模块文档
- L2143: ## 25. Sandbox 详细模块文档
- L2215: ## 26. Automation Scheduler 详细模块文档
- L2273: ## 27. Arena 子系统详细模块文档
- L2358: ## 28. LLM Capability Rules 详细模块文档
- L2435: ## 29. RunStore / FileHistory / SessionManager 风险源码细化
- L2549: ## 30. 端到端链路核验图与 core 文件覆盖矩阵
- L2701: ## 1. 顶层入口 / root
- L2742: ## 2. Engine 模块
- L2819: ## 3. Protocol 模块
- L2872: ## 4. Run 模块
- L2937: ## 5. LLM 模块
- L2996: ## 6. Tool System 模块
- L3050: ## 7. Builtin Tools 模块
- L3076: ## 8. Context 模块
- L3114: ## 9. Session 模块
- L3151: ## 10. Settings / Prompt / Hooks / Plugins / Skills
- L3189: ## 11. Automation 模块
- L3225: ## 12. Arena 模块
- L3265: ## 13. Git / LSP / Runtime / Services / Logging / Utils
- L3303: ## 14. 总风险清单压缩版

## 快速核验命令

```bash
wc -l docs/core-deep-dive.md docs/core-module-reference.md docs/core-complete-review.md
shasum -a 256 docs/core-deep-dive.md docs/core-module-reference.md docs/core-complete-review.md
grep -n '^## ' docs/core-deep-dive.md
grep -n '^## ' docs/core-module-reference.md
grep -n 'Engine.run\|TurnLoop\|ToolExecutor\|RunManager\|AgentServer\|ModelPool\|ContextManager' docs/core-complete-review.md | head -80
```

## 阅读入口建议

1. 先读 `docs/core-module-reference.md`，这是按模块的入口/流程/使用/风险手册。
2. 再读 `docs/core-deep-dive.md`，这是长文档，含源码锚点、风险细化、端到端链路图、覆盖矩阵。
3. 如果只想一次审阅，打开 `docs/core-complete-review.md`。
