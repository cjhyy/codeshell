# Root MCP rename 字段保留复核

倾向单项P3静态意见MCP-R39-01：普通settings-owned MCP条目在full editor只改名称时，新key从表单白名单重建，旧key以null删除，未展示的受支持字段可丢失。该意见仍待独立反证与正式history/Git绑定，不把本prep当已整合的正式项，也不是Root38 args问题的第二次计数。

Root直接读4文件123产品行，全部selected，0test。schema-export1–11明确为手改user/project settings提供$schema自动补全/验证，支持入口不只是孤立zod字段。schema371–400包含有界connectTimeoutMs/connectRetries及inlineImages，属于受支持配置。没有读写真实用户配置、执行schema/export/writer/函数或构造语言fixture。

McpSection1436–1442的Name可在非override模式改变。1375–1395的next从表单字段新建，不包括上述3个字段；429–436把buildMcpSettingsPatch(next, previous)写到新名，并把旧名置null。helper的既有62行已在Root38全文读过，本次仅沿用其同SHA白名单事实，不再声称新增全文读。deepMerge181–215证明同名patch能留住旧record内未写字段，但新key在原map中不存在时仅取新record；旧key:null被删除。不能借同名merge反证改名路径，也不能把问题扩大为所有save都会丢字段。

普通producer的schema手改支持和Name编辑入口已直接读；完整read/merged summary进入full editor及字段实际消费链由parent/独立reviewer各自源范围确认，Root不冒称自己读过其完整链。没有证明实际连接超时、重试或图片行为变化，只支持保存配置字段遗漏。Root38带引号参数问题在不改名时也发生；本项使用简单参数也可成立，根因/修复处不同，不重复登记参数序列化问题。

反证包括有意只编写表单字段的helper白名单、同名deepMerge、plugin override锁名称及schema明确支持的字段。白名单适用于普通编辑并不自动证明重命名应重置受支持配置；需结合原rename合同及独立reviewer确认。修复应保留现有受支持非表单配置，保持删除tombstones与来源边界；本任务不改产品。

读前专门pin先于本次direct display，但peer精确摘录与Root38重叠段已知，initialSemanticReadSha保持null，不倒填首次语义读取时间。123行不代表独有历史新覆盖。[范围](source-manifest.json)、[读前pin](initial-pins.json)、[源显示](source-excerpts.json)。全历史3413扫描由parent/independent另做；Root这里没有完整历史语义去重声明。0产品/helper/语言fixture/测试/React/MCP/probe/config/命令/native/auth/网络执行，0Git，0pass/expect。
