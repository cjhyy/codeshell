# MCP-R39-01 · P3 · 改名丢失未编辑的受支持配置

普通settings-owned MCP服务器已经配置`connectTimeoutMs`、`connectRetries`或`inlineImages`时，在full editor仅修改名称会丢失这些字段。新名称下只写入表单能编写的字段，随后完整旧记录被删除；同名保存会通过递归merge保留它们。

这是第38批“rename extras”未完成边界的后续确认，与MCP-R38-01参数引号问题为不同原因。只有一项问题，没有将三个字段分别计数，也没有改写第38批0候选的原记录。

正常输入来源有明确产品合同：[schema-export注释](../../packages/core/src/settings/schema-export.ts#L4)支持用户手工编辑user/project settings并提供补全和验证；[schema字段](../../packages/core/src/settings/schema.ts#L393)及实际DTO消费者支持这些选项。原配置会进入普通可编辑条目，Name输入框在full模式可改。

[保存分支](../../packages/desktop/src/renderer/settings/McpSection.tsx#L429)把`buildMcpSettingsPatch(next, previous)`写到新key，并将旧key置null。`next`与helper白名单仅含表单字段，previous只用于部分map删键；不会转移上述未编辑选项。[deepMerge](../../packages/desktop/src/main/settings-service.ts#L181)在新key不存在时无法合并旧记录，插入白名单patch并删除旧名，因而丢字段。

白名单有意限定表单能编写的字段，本身不是问题。同名保存、插件override锁名称均是重要反证与范围限制。这里仅确认支持的非表单字段在改名时丢失，不承诺保留任意未知键，不声称实际连接失败、启动超时、图片处理变化或数据损坏。

建议改名时转移原有受支持配置，再应用编辑字段patch，保持删除标记及来源合同，避免把界面元数据写回配置。仅记录，未修改产品。

[作者报告](evidence/mcp-rename-fields-frontier/report.md)、[独立反证](evidence/mcp-rename-review/review.md)、[Root复核](evidence/root-mcp-rename-frontier/review.md)、[分类](findings.json)、[源码与归属](source-manifest.json)、[验证边界](validation.json)保存静态证据。0函数/语言fixture/测试/表单/真实配置/MCP/命令/网络执行，未观察运行时结果。
