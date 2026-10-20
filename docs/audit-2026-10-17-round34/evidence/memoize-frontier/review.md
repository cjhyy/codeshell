# Future34 memoize 同版本复核与sanitizer覆盖gate

有限结论 **0 new formal / 0 candidate / 0 new-related**。完整历史先于叶子语义阅读检查，R27两份结构化source清单已明确memoize35、task-sanitizer34全文范围，SHA精确等于当前文件；不是仅靠库存/hash猜测旧覆盖。按允许范围只选memoize做同版本复核，task-sanitizer保持hash-only，不包装为新的未读frontier。

## 普通缓存合同

memoize全文35行先算resolver key，get与has共同判断hit，cached undefined不会丢失；fn执行成功后才cache.set，同步throw没有写入缓存。当前所读真实plugin loader在208缓存scanOnce，resolver由home与installed registry mtime组成；scanPluginCommands返回memoized结果，invalidate入口显式clear。只读170–218选段49行，122的同步scanOnce签名及22的import只作locator摘录，不计完整loader阅读。

helper明确cache随返回函数生命周期且非LRU。当前普通callback为同步扫描；未建立需要receiver绑定、替换整个.cache或特殊Promise拒绝策略的真实consumer反例，不造Promise/语言fixture。外部key失效、目录内容与mtime正确性没有验证，旧Skill parser/registry和其它failed方向没有恢复。

读R16现存纯callback测试源码93行，7个声明覆盖resolver、同key复用、undefined/falsy、side-channel、clear和同步throw控制；**没有执行、重写或新建fixture**。R16旧7pass/36expect仅属历史记录。全文读R16报告23与R27报告13，既有原因及设计边界保持旧记录；当前same-SHA full的直接证据来自R27明确coverage/ranges。

## 历史、时点和范围

[history](history.json)确切记录12:22 UTC扫描时点，排除当时mutable32/33/future34，含archive及MD/递归JSON值标量：2988=1304MD+1684JSON、645399strings/957193scalars，0parseerror。exact325/cache-text1579/old-failed10为occurrences，保存60/60/10（cap60）；实际读exact前20、failed10与4个same-SHA full结构化row，另外直接读两个父report，没有声称1579个上下文语义穷尽。

[结束检查](history-finish-checks.json)逐项核2988库存字节未变，未发现release doc漂移，没有覆盖首份dated snapshot。之后Root报告Round33整合40d79ff2190a98aa31067eb07006099c2726b21a；这不追改本prep的旧排除范围。正式history差集和冻结Git由Root后续完成。

[source manifest](source-manifest.json)的5个实际语义rows合计84行产品source、93行既有历史test声明、36行旧报告；4项hash-only（含task-sanitizer和指令）另列。两个旧report的专门pin晚于scanner excerpt，initialSemanticReadSha256保持null，其后才直接全文读。所有产品source pins先于本次声明范围阅读，结束SHA一致。

一次filename-only rg在packages/tests未找到memoize测试，tool c3f90e最终exit1，前段已打印leaf和真实consumer路径；后续从实际docs库存找到旧R16测试。它不是产品失败、测试重跑或package resolver替代验证，完整raw未单独落盘的限制在manifest中保留。

**0产品/import/函数/测试/Promise或语言fixture/loader/scanner/用户数据/native/模型/网络/Git执行，0pass/expect**。未改仓库、旧Round32/33或其它作者材料。终态[receipt](reviewer-receipt.json)只证明有限审计材料字节。
