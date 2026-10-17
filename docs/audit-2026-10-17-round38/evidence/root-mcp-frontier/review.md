# Root MCP args roundtrip 静态复核

支持将普通设置表单的args回填/再解析记录为单项P3静态问题，暂称MCP-R38-01，与parent及独立reviewer为同一项，不新增第二个ID。Root只读2产品文件281行，另107行相邻显示/导航不计语义覆盖；首次范围表保留，没有函数、语言fixture、表单、MCP、probe、命令、设置或网络执行。

普通full stdio编辑入口从卡片onEdit设置edit状态(649–666)，McpEditor以servers已有项为initial(699–716)。Args Input将原文本送setArgs(1465–1483)，submit检查正常name/command，没有dirty短路(1300–1320)，1384每次用splitArgs。该函数注释和实际1870–1893分支均接受成对引号包围的非空含空格参数。故表单自身能先创建含单个空格参数的args数组，不需要外部坏DTO。例如用户文本`--label "team alpha"`在源算法中对应一个label值；这里只是静态输入推导，没有运行这个表达式。

saveEdit430调用buildMcpSettingsPatch，436写scoped settings，438–441保留next，449关闭编辑器；helper59对args数组只复制。重新打开时1122用join(" ")回填，原单参数内部空格与参数之间分隔无法再区分。未修改任何Args文本再次保存时1384仍解析，splitArgs1882–1885把未引号空格分为多个参数。输出数组已在写入前改变，可导致后续启动收到不同argv；未执行启动或观察服务器失败。

同名编辑的递归merge不会恢复已经改变的数组。适用普通full stdio模式；plugin override明确锁args，不能扩大到override。现有name/command校验、savePending和editor mount guard不提供quote-preserving序列化，也没有在未修改时跳过args。rename额外schema字段是另一未完成边界，本Root意见不升级该线索。

Root读前pin早于本次direct display，但已见peer精确摘录，initialSemanticReadSha保持null。首次source-manifest反映较宽显示范围，final另列实际语义范围与107相邻行；没有回填首次时间。首个txt快照仍留在本tmp目录，其精确bytes/text也编码保存到source-excerpts.json，正式copy可仅保留JSON编码。

历史全库3318扫描和精确旧因上下文由parent负责，Root不冒称自己重做完整扫描。旧MCP headers的分隔符显示、R26 TUI先split再join的双空格、R8插件空quoted token是不同producer/模块/修复处；仍需结合其冻结history与独立reviewer收据汇总。不把普通UI消费者当作旧TUI/CLI失败方向的重新运行。

[source范围](source-manifest.json)、[读前pin](initial-pins.json)、[验证边界](validation.json)、[首个源显示编码](source-excerpts.json)。0测试声明、0pass/expect，未改产品、未做Git写入。
