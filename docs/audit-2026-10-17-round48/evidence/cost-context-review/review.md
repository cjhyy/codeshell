# Core cost context 独立静态复核

有限结论：**0 formal / 0 candidate / 0 related**。仅覆盖普通cost/usage上下文DTO、可见回调和选定caller，未发现有足够普通producer证据的新问题；不等于该模块、AsyncLocalStorage、SDK或账本所有行为正确。未读、未索取61作者的报告/manifest/excerpts/发现；本次独立阅读只写这个exact tmp目录。

[初始pin](initial-pins.json)在正文前记录context.ts：167行/5823B、SHA91ab442184ca82d512c2722c64205c27470db2a6c29bde1fe2883f24d96c99ee。AGENTS/CODESHELL为此前已读并携带的相同指令hash，本次重复pin不双计语义。Root提供c3a9ece2e6f183671b00e07322a9722fad6bda54仅外部上下文，本reviewer Git0。

[Fresh gate](history.json)纳冻46、排exact47及57–65：4255=1423MD+2832JSON，1765237string/2662013scalar，169 exact archive/_archive目录、0parse。MD全文文本和递归JSON value scalars均参与机器检索，keys不当作scalar搜索；path57/filename58/SHA11/oldCause79均在cap100内保留。[原始object](coverage-gate-objects.json)共22个精确path/SHA对象，已核scope/coverage/review/readScope/inspectionScope相关字段。R9 evidence/root-source-manifest.json /files/16仅“Selected implementation/excerpt read”而非sameSHA full；R28/R44派生pin/unknown不构成未读证明。未发现sameSHA旧full门槛，所以进入正文，见[gate decision](gate-decision.json)。

旧COST-R9-01是未绑定standalone CostTracker丢完整model identifier并估价错误；本轮不重报、不借旧执行结果。历史79命中均保留，不声称语义读尽所有历史文档/机器scalar；实际用于判断的是全部精确path/SHA object的压缩元数据、11个SHA窗口、canonical旧finding及其原scope。预算/429/真实重试方向未重开。

[源码清单](source-manifest.json)：7个selected文件、329语义行=295产品+34测试；8个产品/测试文件累计唯一显示523行（含1个navigation-only model-traces文件），0 full。context全167行显示，普通语义162行；crypto import/hash/random生成2/134–136与store type import4只作导航，不认证这些机制。[后捕获片段](source-excerpts.json)诚实记录在实际显示之后保存，初始与结束SHA相同，不冒称片段先于阅读捕获。[caller初始pins](consumer-initial-pins.json)均在正文或line-navigation显示前，先前rg只列文件名。

普通链的源码反证足以收口：

- LLMBase 90–149将createMessage包装到withUsageAccounting；usageIdentity保留provider/model/providerKind。billingEnabled控制attempt和record路径，requestVisible只控制前台计数；usagePurpose通过withUsagePurpose覆盖owner的普通purpose值。没有把旧standalone估价问题扩成当前上下文新问题。
- context 61–98可见owner/purpose到attempt对象的传递、enabled/no-owner分支，以及operation成功/失败时的receipt finish回调；101–126区分当前attempt settle与无attempt的单次receipt路径。account仅包含可见同步ledger调用异常并记录失败，未推断异步ledger或平台调度的额外保证。
- currentUsageAttempt 49–58只投影声明的字段并冻结返回值；wrapper137–151在ledger.begin前设置latestIdentity。选定accounting.test.ts声明表达begin同步失败时仍能观察attempt字段的意图；不是本轮运行结果，也不认证requestId crypto实现。
- Engine 1957–1961/1966–1968是实际主流程owner-returning边界和包装调用，UsageReceipt/TokenUsage类型给出正常字段合同。ledger.test.ts 257–270表达禁用嵌套attempt的意图。两个声明均未执行，Node AsyncLocalStorage的实际传播/恢复、SDK回调时序不作运行断言。

owner身份/namespace/lineage、ledger store/锁/persist/pricing、hash实现、真实账单/账号配置均停在边界；没有打开真实配置或调用这些机制。Engine相邻hooks/权限片段、ledger邻接身份/localhost SDK retry代码、boundary签名import及model-trace requestId locator虽有显示，均列navigation/display排除，不扩大语义范围或借旧tests pass。未因Node/SDK行为不确定而构造bug或候选。

[分类](classification.json)和[validation](validation.json)保留0/0/0及旧因排除。产品/helper/import/ASLS样例/fixture/测试/UI/provider/服务器/native/网络/Git运行均0，产品写入0。所有命令exit0、无工具截断或需隐去的metadata首错。最后[ending checks](ending-checks.json)的10个产品/指令pins全同，4255历史集合无增删/字节漂移；Root随后报告47已FF2735100f81f4d12cbb3e610da0e3977eaf74727c且仅91份docs47变更，这仅外部通知，原4255纳46排47时点保留；本reviewer未调用Git。不倒写初始时点，也不认证Root未来分支。冻结文件见[receipt](reviewer-receipt.json)。
