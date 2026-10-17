# 正式43历史问题目录：独立元数据核对

核对通过：42份canonical findings元数据与目录的 **111条记录、111个唯一ID、44条P2/67条P3** 全部对应，0差异。每份原reported count、直接formal列表与目录内同轮有序ID列表一致。Round1使用旧schema的 `issues`/`total`，其余使用 `findings`/`count`；5条priority直接取原severity值，没有改级。

所有 id/title/priority/sourceRound/canonical路径及原baseline逐值对应。原有76个status、30个fixed和10个currentMainSourceDisposition均保留原值与类型，包含false以及嵌套source-addressed说明；缺省字段仅按目录schema映射为null。字符串不trim、翻译或归一化，原文件bytes另有读前/结束SHA绑定；不声称两个JSON文件的空白或转义写法逐字相同。

只按42个指定canonical根路径读取顶层formal列表，未递归收集candidate、related、nested evidence或archive副本。此处只核ID唯一与来源列表完整性，**不重新做根因去重，也不判断当前修复状态**。111是前42批的正式历史记录，含旧known或后来source-addressed项目，不是111个当前未修问题或111个首次新根因。

catalog读前与结束均为71885B，SHA `6e9e8a286a6e07a1306e7d007bad8935f15e202a9d1e44878b9589b9a6cf6075`；42份原元数据同样无字节漂移。只在 [checks](checks.json) 保留必要hash/count/ID清单，没有复制42份完整记录。`files=[]`，原42份另列canonicalMetadataDocuments。

0产品/源码/测试正文读取，0产品函数、fixture、动态运行或Git操作；未读取或运行catalog-method.py。目录header baseline及baselineBlobMatches只是原作者元数据，未做Git/blob认证；未来README/人类目录未检查。本次只写exact tmp，冻结见 [receipt](artifact-receipt.json)。
