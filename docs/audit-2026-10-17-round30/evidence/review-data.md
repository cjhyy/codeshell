# Round30 data 独立审查与正式化复核

结论：支持 [data报告](../data-report.md) 维持 **0 new formal / 0 candidate / 0 new-related，1 A04 existing-cause exclusion**。没有发现需要修改作者分类或元数据的事项。正式 baseline `19efab9225723c76af447f8b9d9f65aace3b0780` 与 branch `codex/audit/data-helper-round30-20261017` 由 Root 提供；reviewer 0 Git，冻结 Git blob 由 Root 独立绑定。

## 原独立语义审查

原 [review prep](data-review-prep/review.md) 等作者 freeze 后才读取其最终产物与普通 source 链，独立读前 pins、范围和结束 hash 都已保留。审查同一次阅读的9个产品/测试路径600行，以及2个旧报告78行：channel和parse-log全文222行，既有测试声明126行，producer/consumer选段252行。media仅hash；指令沿用此前已读且SHA相同的内容，不增加本轮语义行数。

裸 `|` 的 parser、实际 `%H|%s|%an|%ci` producer，以及coding dynamic context/TUI近期风格提示，正是旧A04已记录的原因与两个后果；R13也明确排除相同问题，故不重复登记或增加related。channel的显式能力优先、legacy fallback、kind predicate、webhook inventory与catalog接线，在所读普通合同中没有建立新反例。未推断对象运行时不可变、完整thread支持、平台限额或实际transport行为；旧Discord失败方向保持SKIP。

上述600+78行只计为同一次 prep 阅读。**正式化新增产品或旧source语义阅读为0**，没有重读产品再计第二份覆盖。原结论的普通调用链、历史因果和局限详见原review；正式化仅核元数据与字节。

## 正式元数据复核

六份原独立review材料已逐字复制到 `data-review-prep/`，包括自排除5文件的原reviewer receipt；[独立copy receipt](review-data-copy-receipt.json)保存源/目标hash。原父上下文 `b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`、原时间、2765项历史和其当时排除29/30的口径都未修改。它们不冒充正式Round30时点证据。

收到作者正式freeze后，先durable pin其9个formal文件（8收据artifacts与receipt自身），再读formal报告和元数据。12个normalized source rows的当前hash、范围、semanticLines与原prep一致，且各 `prepSourceRow` 完整逐项保留；unused media独立为hash-only。两个旧报告initialSemanticReadSha256仍为null，未补称作者早于excerpt捕获。作者11份prep复制和reviewer6份复制均字节一致；8份formal收据条目、receipt和11个报告链接均核对通过。

正式历史库存独立核得2851项=1285MD+1566JSON，逐项当前字节匹配；JSON值递归重计597236 strings/884863 scalars，0解析错误。原2765项row/hash全部相同，没有删除或改写，仅新增86份冻结Round29文件；当前文件库存准确排除Round30。archive/_archive精确目录component169、仅literal archive162、substring174口径一致。作者127/175/16 occurrence与100/100/16 capped contexts保留为搜索导航，不称为历史语义穷尽。

核对明细在 [正式source/check manifest](review-data-source-manifest.json)。其中11个source/contract rows沿用原覆盖，当前Round30报告、JSON、receipt与copies另列；它们不被声称为19ef基线中的原始源码blob。文件hash和库存/JSON值扫描不增加产品语义阅读，也不代表全部历史逐份理解。

作者与reviewer均无本轮产品函数/import/测试/fixture/Git/React/browser/VM/native/网络/模型执行，0pass/0expect；formal validation runs为空。没有触发auth/permission/identity/journal/lock或真实任务实验，没有恢复旧失败方向。该negative仅覆盖已声明的普通数据合同，不能外推全仓或平台交互无bug。
