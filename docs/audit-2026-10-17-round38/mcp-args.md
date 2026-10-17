# MCP-R38-01 · P3 · 再次保存MCP表单改变原有参数边界

普通stdio MCP服务器的Args表单支持用引号输入含空格的单个参数，但重开编辑器时用空格直接拼接已有数组，丢失引号。用户不改Args而再次保存，也会重新解析这段文本，将原单个参数拆开，写入不同的args数组。

表单自身能产生这个状态：Args输入`--label "team alpha"`时，`splitArgs`的引号分支将label值保留为一个非空参数。这里只作源码分支推导，没有运行表达式、测试、表单、MCP连接或命令。

- [回填位置](../../packages/desktop/src/renderer/settings/McpSection.tsx#L1122)调用`(initial?.args ?? []).join(" ")`。数组元素内的空格因而与元素之间的空格混在一起。
- [保存位置](../../packages/desktop/src/renderer/settings/McpSection.tsx#L1384)对stdio表单总是再次调用`splitArgs`；普通name/command校验及保存状态guard没有在Args未修改时保留原数组。
- `splitArgs`1870–1893明确支持成对引号；1882–1885将未引号的空白作为分隔。保存路径的patch只复制这个新数组，递归merge不恢复已经改变的元素边界。

卡片Edit、full editor的initial、onSave、saveEdit和scoped设置写入构成普通入口；重新加载会保留数组并交给该回填位置。适用full stdio编辑；插件override锁住args，不属于本项。影响是配置中的argv变化，后续启动可能收到不同参数；未观察实机启动结果或声称连接失败。

建议使用与解析器匹配的无损序列化，或直接编辑参数数组；未改字段应保留原有数组。需要同时保留含空格/引号等正常参数，而不是仅为某个示例加引号。产品未修改。

[原作者](evidence/mcp-patch-frontier/report.md)、[独立反证](evidence/mcp-args-review/review.md)、[Root复核](evidence/root-mcp-frontier/review.md)、[源码与归属](source-manifest.json)、[分类](findings.json)、[验证边界](validation.json)、[聚合复核](evidence/review-aggregate.md)分别保存。本项与旧MCP headers分隔符显示、TUI命令分词及插件空quoted token不同，精确去重局限于所列历史查询和实际上下文。
