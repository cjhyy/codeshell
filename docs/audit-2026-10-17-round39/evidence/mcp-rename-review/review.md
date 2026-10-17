# MCP rename supported-fields independent static review

独立源码意见支持同一项 **MCP-R39-01 / 建议 P3**；不新增问题 ID、candidate 或 related。最终正式分类由 Root 决定。本意见只涉及普通用户自行配置、可编辑的 stdio server：原记录有受支持的非表单字段，新名字尚不存在，只改 Name 后保存。这是静态字段保留缺口，未观察实际 UI 操作、文件写入或连接结果。

`schema-export.ts:1–11` 明文支持用户手改用户或项目 settings 文件，以导出的 JSON Schema 获得 autocomplete 与 validation。这为普通 producer 提供了明确产品合同，依据不限于 schema 接受任意数据。`schema.ts:393–396`、`types.ts:1165–1176` 声明 `connectTimeoutMs`、`connectRetries`、`inlineImages`；实际配置快照及 manager 选段消费这些字段。README 的通用设置示例只作背景，未当作这些 MCP 字段的独立文档；也未建立通用 JSON 编辑器入口。

当前普通数据链为：读取 scoped settings 并加载列表 → 可编辑记录进入 full editor → Name 状态可改且校验非空、唯一 → submit 从表单状态构造 `next` → `saveServer` 在新名字下调用 `buildMcpSettingsPatch`，同时旧名字写 `null` → settings writer 对 patch 做递归合并。`next` 未展开原记录，helper 又明确只编写表单白名单字段；三个受支持但未显示的字段因此不在新记录中。`deepMerge` 对不存在的新键只写新对象，同时删除旧键，无法从另一个旧名字继承这些字段。数据链和实际范围见[源清单](source-manifest.json)。

这些反证限定了问题范围：

- helper 白名单是明确的作者策略，遗漏本身不能证明所有 save 都有错。同名保存会在原 key 上递归合并，保留未出现的字段。
- plugin override 的 Name 被禁用，并采用补充字段路径；它不属于本次可达条件。
- 名字唯一性校验挡住已有名字冲突；本结论使用正常、尚未占用的新名字。
- 注释明确追求 atomic rename，旧键删除是设计意图；原子提交并未实现受支持隐藏字段的迁移。已读范围内未找到“只改名即重置这些字段”的规则或提示。
- 不要求保留任意未知扩展字段；不把 UI `source` / `editable` 元数据当成应写回配置的字段。不推断实际 timeout、retry、图片、连接身份、安全或权限后果。

[判定记录](decisions.json)保存上述强度和反证。与作者同因果去重，只支持同一项；已读作者冻结报告和结构化声明，未将作者全部产品阅读记作本 reviewer 的阅读。[作者元数据复核](author-metadata-checks.json)显示其 19 条收据记录及包含 receipt 的 20 文件集合匹配，29 条语义/导航 pins 加 183 条 hash-only pins 的 212 次当前字节核对均匹配。5.53 MB 原始历史对象仅核字节，未打印或声称语义读完；作者报告仍见[原报告](../codeshell-audit-round39-mcp-rename-fields-frontier/report.md)。

历史 gate 是独立 dated 扫描：docs/bugs 全 MD 与递归 JSON scalar values，含 archives、冻结37，排除当时 mutable38 / future39。共 3413 文件（1352 MD、2061 JSON）、887511 string values、1329022 scalar values，JSON parse error 0。四组查询命中为 69 / 77 / 11 / 12，cap 每组160，均未截断保存。实际语义读了 12 个字段命中上下文、5 个同 SHA 元数据行，以及从 locator 选出的61条记录按完全相同 context 去重后的7段文字；不声称其余所有 locator 或全部历史文档都语义读完。首次61条打印被截断，原文件保留，随后7段完整打印。[历史判定](history-decisions.json)及[原扫描](history.json)保留口径。旧 Round4 inline-image 序列化、旧 MCP header 显示、已知38 args roundtrip 均不是本次改名迁移根因；未据库存行声称历史从未读过该文件。作者另核 September11 atomic rename 历史属于作者证据，并未冒充本 reviewer 重读。

结束时 3413 included 路径集合一致，3412 原字节不变；release TODO 单文件从 189803 B / `c8cdef20…` 变为 199956 B / `8c1b9ca1…`，精确值保存在[历史结束检查](history-finish-check.json)。初始查询时点不覆盖、不重扫为“全 current”；冻结38的后续差集和正式当前历史由 Root 单列。原 prep parent `bbad45be04dacfecb29cba04ed51caf167fe4e53` 保持，formalBaseline 为 null；后续 HEAD 42683054… 仅为 Root 供给上下文，本 reviewer 未运行 Git 绑定。

本 reviewer 12 pins 中 11 个有本次语义范围，3 full / 8 selected / 1 hash-only，共 561 行：504 product、34 existing-test declaration、23 documentation；包含与已冻38及作者重叠的行，不作全局独有行数相加。12 个初始和结束源码字节均一致。README 专用 pin 晚于初始 locator，`initialSemanticReadSha256` 保持 null。邻近打印的锁、恢复、权限分支未纳机制审查。

产品、helper/schema/parser/import、语言 fixture、测试、React/browser、MCP/连接/命令、实际配置/HOME、网络/native/模型/权限实验和 Git 均为 **0**。既有测试声明不是本轮通过证明，未恢复旧失败方向。[validation](validation.json)与[metadata 诊断](metadata-diagnostics.json)保留一次 JSON schema 误读导致的 metadata TypeError exit1、导航输出截断和 late history drift；它们未触发产品重跑。[本 reviewer 收据](author-receipt.json)自排除以避免递归哈希。
