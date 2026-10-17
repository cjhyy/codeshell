# 第53批：普通数据投影与工具摘要

新增 **2项P3**，累计正式历史问题 **116项：44P2、72P3**，不是当前未修复数。[全部116项列表](ALL-ISSUES.md)、[机器目录](recorded-findings-catalog.json)。

- **TUI-R53-01**：Glob正常成功结果的标题或无匹配提示被当成文件行。默认CLI单匹配显示2files；TUI零匹配显示1files，collapsed/expanded相同。原结果与搜索数据保留。与May30 /123的producer超过200缺header/单复数不一致明确区分。Root111沿真实消费者找到原因，112独立闭合builtin注册/字符串成功、result字段、TUI投影及CLI默认text路由。
- **TUI-R53-02**：路径摘要只认斜杠起始的绝对值，正常Windows盘符绝对路径不会按cwd缩短。较长共同cwd占满60字符预算时，不同文件的相对尾部不可见。Root111源码线索经113独立定向复核、Root114亲读普通绝对路径合同支持。平台badge和Desktop发布matrix仅支持背景，不代表完整Windows CLI运行验收。

两项均为静态确认，未执行产品/helper/test/CLI/TUI/Windows/TTY/DOM/FS/native或语言算式。见[正式问题](findings.json)、[Root111](evidence/root-tool-display/report.md)、[112计数复核](evidence/glob-summary-review/review.md)、[113路径复核](evidence/windows-path-review/review.md)、[Root114合同](evidence/root-windows-contract/report.md)。旧UTF16、Read字节标签、Glob全局最新200候选与失败动态方向不重复晋升或恢复。

[107trace查询](evidence/trace-history/report.md)只核普通校验/DTO/真实页消费；target78行全与R49重叠，其它必要consumer也保留旧读，不作新唯一覆盖。[108缓存DTO](evidence/cache-data/report.md)保留section-cache原full字段与ancestor navigation冲突、暂缓确定全文，fallback只读model-cache普通key/value与实际fetcher边界，FS/clock和旧reload失败不展开。有限范围各0新问题。

[109Web格式门槛](evidence/web-format-gate/report.md)两同SHA旧全文目标正文前排除；[Root110解析门槛](evidence/root-task-parse-gate/report.md)由R32原full190行/版本/SHA及MD限定排除重复parse-task。不是新无bug结论，也不额外激活消费者全文。112/113是具体新因果的定向选段复核，保留旧full和CLI gate时序，不把它们当首次或新全文。

八包107–114逐字节归档，full/selected/nav/hash/metadata、测试声明与执行、首错/截断均保留。[范围](coverage.json)、[源码版本](source-manifest.json)、[验证](validation.json)、[索引](evidence-index.json)、[归档复核](evidence/review-aggregate.md)。所有源读者冻结后才刷新main；冻结审读与当前SHA分开，历史原5150库存不倒填。只提交审查文档、不push，主目录原改动保留。

总体覆盖仍为dated45的4643TS/TSX：304全文/169选段/4170未知。46–53未统一回填，4339不是未读或精确剩余数；全仓审查继续active。没有产品/测试/React/clock/timer/真实数据/model/network/native实验，所有先前失败动态方向保持SKIP。
