# 工具目录审查的只读交叉复核

复核冻结源 `248d091202869c07274adedf4fd50403105f1b1f`。阅读 `tools.md`、候选/验证/源清单、两份首轮日志与退出收据、fixture、artifact receipt、preflight 原草稿和说明，以及 Registry、ToolSearch、RunToolSurface、既有 surface 测试、Engine/MCP 注册接线和公共导出。没有执行测试、包入口、真实工具、网络、Git 写操作或产品编辑。

**结论：0 项确认、1 项未确认 API 契约候选的处理合理，未发现必须纠正的实质问题。** `registerTool` 的定义和 registration ID 确实无条件替换，但 executor 仅在参数存在时替换；同名 definition-only 注册后，旧 disposer 不再移除新注册，而旧 executor 保留。fixture 使用真实 Registry/ToolSearch 和完全在内存中的 fake executor，能够证明新 metadata 与旧实现并存。fresh definition-only 拒绝执行、显式替换 executor 及两个 disposer 的对照相关且有效。

`ToolRegistry` 由公共 `index.ts:138` 导出，`hasExecutor` 注释认可无实现的动态定义，因此该现象值得保留。但“公共导出”本身不等于“省略 executor 必须清除原 executor”的承诺。所读 Registry 方法没有给出这种替换语义；Engine `registerCustomTool` 必传 executor，MCP discovery 注册也显式提供 executor。当前证据不足以排除有意只更新 metadata 的解释，更没有证明实际 Host 正常流程错误执行。报告没有把 API 假设或 fake 调用扩成已确认产品缺陷，降级为 `unconfirmed-contract-gap` 合理。

两份原始日志分别为 **3 pass / 18 expect** 和 **14 pass / 79 expect**，均有 `Completed Bun shard`、0 failure、0 skipped，退出文件均为 0；总计 **17 pass / 97 expect** 与报告、validation 一致。新增为 3 项，既有基线为 14 项，不是 17 项新增缺陷测试。RunToolSurface 的 14 项仅操作内存目录、选择集合、clone/freeze 和普通 schema 数据；名称含 revocation/authorized 的测试没有启动真实权限系统、Host 或 provider。报告也明确没有执行整份 ToolSearch 测试，覆盖声明保持了边界。

预检的原 regex 草稿保留了虚假 bare specifier `, ` 和 require-condition 解析问题；最终 metadata receipt 改用 TypeScript AST 和 import condition。`tools-preflight-note.md` 明确将这次更正定位于任何测试前，两个 test receipt 均记录 first attempt，所留材料没有失败测试日志或重复执行证据。此处应继续算依赖元数据预检纠正，不能计成失败 fixture 的修复/重试。283 个源文件、636 条相对 imports 和 35 条 bare imports 是静态依赖图元数据，不是源码全部阅读或模块全部执行的证明，正文已作此区分。

独立以冻结 Git blob 复核源清单的 **18 个文件 SHA-256** 和当前字节一致性，并核对 artifact receipt 的 **16 个文件长度及 SHA-256**，均匹配。查重收据保留 parsed JSON 的记录/上下文与范围，正文没有把关键词搜索说成新颖性或正确性的充分证明。没有额外测试结果或新的 finding 来自本次交叉复核。
