# Round28 结构化阅读覆盖索引

本项不是bug发现或产品测试。它帮助选择后续审查范围，**不能证明哪些文件从未读过，或整个仓库有多大比例已审完**。[原8份prep副本](evidence/coverage-prep-copy-receipt.json) 保留parent-reported9b、metadata方法和时点；Root当前baseline32c仅新增审查文档，当前另做filesystem hash-only复核，不改原prep字段。

`rg`库存为packages内 **4087个TS/TSX、949503行**。方法只从162份文件名匹配source-manifest的JSON提取明确path+SHA+scope/ranges；其它prose、receipt、历史手工阅读和其它文件类型均未算入。“当前同SHA且明确full”96、selected59、pin-only869、仅旧版本27、没有matching structured row3036；五类合计4087。raw claim rows与去重current文件数量不同，不能相加或按作者复制次数当独立覆盖。

完整 [package inventory](evidence/coverage-prep/package-inventory.json) 只含metadata/hash；[coverage index](evidence/coverage-prep/coverage-index.json) 与 [ranking](evidence/coverage-prep/coverage-ranking.json) 给出claim来源/版本/保守分类。[方法源码](evidence/coverage-prep/coverage-method.py) 不是被审产品，也没有运行产品imports/AST/VM。full只接受显式标签，selected即使ranges合起来覆盖全文也不升级，currentSha不取代当时frozen/readSHA。190项缺少合法SHA的旧row被排除；这反映索引规则，不证明旧审查没做。

242个零runtime-import文本候选还经过命名/语法导航过滤；regex不会证明helper纯、不会排除所有副作用。前三个实质提议是splitStreamingMarkdown、dialogState、sessionStatus，Root先读真实源码和调用边界后才各自审查，没有直接运行候选。sessionStatus在旧R18导航/设计prose已被提到，却没有matching structured row，正好是“no row不等于从未读过”的反例。TUI/Core的旧失败方向和权限、native、模型等没有被索引提议当作执行授权。

原shortlist去重是当前2677 docs/bugs MD+JSON value scalars，1262MD/1415JSON、506929strings/740424scalars、169 exact archive/_archive路径、0parseerrors；不同query总命中及cap在原文件保留。仅profile/root查询与old Lab prep2596分别属于不同读取时点，不把两份库存混成同一快照。

[Root current recheck](evidence/coverage-current-recheck.json) 对4087库存文件逐一复核字节/SHA；这仍是hash-only，未给4087文件绑定Git或声称全文语义阅读。后续若main变化，原profile是旧时点metadata，应保留并另记delta，不能把它转成最新源码覆盖证明。本轮实际full/selected范围只以各作者source-manifest为准。

[validation](evidence/coverage-validation.json) 全部产品/测试计数为0；没有raw/exit需要伪造，也没有修改产品。全仓审查目标继续active。
