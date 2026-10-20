# Prep123 — Chat正文与附件的普通数据链

有限结论 **0 新 formal / 0 candidate / 0 new-related**。针对“正常send同时含正文与附件时丢部分内容或改变顺序”的新问题，所读Mimi gateway→Telegram源链提供反证；没有实际发送消息、调用SDK/helper或运行测试，也不认证全部adapter、平台quota、失败重试或下载机制。[分类](classification.json)保留具体边界。

Root提供产品baseline `00c046367769349c1f5413e74c993b2c19ce8337`，仅为外部上下文，Git0。实际filename确认 `packages/chat/src/media.ts`272行 / 9244B / SHA `9cd43efac474d03615408fd8ab094c3136ef1972d399b72fc30c362487dabe14`；[初始pin](initial-pins.json)在正文/导航前。AGENTS5/CODESHELL217的先前实际阅读沿用同SHA，不重复计新阅读。

先做精确path/SHA原始文本命中定位，[46份命中文档](targeted-history-hits.json)逐项hash。此搜索不自称穷尽所有转义JSON表达，也没有重跑全仓million-scalar扫描。再只递归六份selected canonical元数据容器的JSON值，1511scalars / 800strings / 156objects / 115arrays，保存 [七个原row](canonical-gate-rows.json)。R11 `/files/6` 明确full source read；R20 `/files/0` 为Full mixed source static，原media-kind.md13明确整mixed module静态读；R23 `/files/7` Full exploratory，原frontier-selection5解释实际读文件、非全部跨层合同认证，且三者均同当前SHA。R30/R43后来的hash-only记录不能抹去旧全文。没有以unknown/no-row当作未读。

最初按旧全文在当前正文前排除；随后Root明确授权在同SHA上定向复核新的组合问题，因此本次selected重读按重叠记录，**不宣称新唯一target覆盖**。[gate decision](gate-decision.json)保存canonical范围、实际MD行与角色变化。旧 [R11候选/排除原件](old-cause-canonical.json)和旧chat-data17–25明确CHD02是长附件名UTF16截断；无契约的filename/MIME冲突、并发同对象tracker猜测不升缺陷，Mattermost语法、Discord旧失败、平台字节限制均未重开。

Root另共享纳正式54、排正式55+的批量历史。本包仅 [pin其冻结字节](shared-history-pin.json)并 [投影media命中](shared-history-media.json)：5433份MD/JSON、3997418递归JSON value scalars、0parse错误，media path/SHA合计353命中，cap100保存前100。机器数量归Root，非本读者再次全量扫描或人已语义读完全部值；本轮实际阅读是上述canonical原row、原MD匹配行和小型旧候选原件。初始46命中记录原来未确定formal排除号的字段保留，后核46条均不在formal55+，没有倒写初始时点。

正常组合问题的实际链如下：

- `OutgoingMessage`声明text和可选attachments，附件携带kind/name/MIME/data。实际gateway245–260把结果正文分块后逐条构造OutgoingMessage，把支持且已materialize的附件挂在末条；263–265的异常fallback保留正文，未展开materializer或真实文件。200–202逐条await reply，`chat-gateway.ts:111`实际将原outgoing转交`adapter.send(message.target,outgoing)`。这是真实producer与dispatcher，未凭任意DTO制造入口。
- media198–222对附件数量、kind、bytes和MIME作既有检查并返回原列表，没有改写正文或重排附件；这些是源码内部检查，不是当前平台quota声明。media250–272在正常send计划中按step顺序await，成功后递增索引。本次只核正常顺序，旧并发/失败ACK与重试机制不作认证。
- Telegram150–170/173–190首先为非空text/button构造正文step，再按attachments原序map出media steps，附件name/MIME和byte copy进入multipart字段。正文使用独立文本请求而非同一caption字段，并未由此丢掉正文或附件；没有声称这是单次原子发布或观察到平台接收结果。时间/网络/token实现只相邻显示、未运行或认证。
- 既有Telegram测试只选读blank text+image的字段/MIME/name/bytes意图；平台媒体测试的两个声明表达Discord/Slack同时caption+image的预期。仅声明，不借其作为当前通过，也没从测试推论其他adapter源码正确。Telegram入站 `text ?? caption`只作导航，没有假定平台会普通产生同时具备两个字段的消息。

[Source manifest](source-manifest.json)为 **7 selected / 0 full，200语义行 = 144产品 + 56测试声明，累计唯一显示449行**。media的48语义行全部是既有同SHA全文的定向重叠；其他必要消费者不声称历史唯一覆盖。[support pins](support-initial-pins.json)、[producer pins](producer-initial-pins.json)、[dispatcher pin](dispatcher-initial-pin.json)均早于各自正文/行导航。lifecycle.ts只hash未读，另列hash-only；instruction pins不算产品语义。displayed ranges与additionalNavigationSnippetLines分别存储并取union，机制邻接不纳普通语义。

[摘录](source-excerpts.json)是在实际显示后捕获，只有原显示行，不冒充pre-read快照。测试为3个partial declarations、17个普通标题及1个参数化描述导航，0执行；没有导入platform SDK、下载附件、操作账户、连接网络、真实配置/文件或消息。权限/身份、URL/private-address、path-custody、materializer和完整dispatcher生命周期均停在边界。

首非零命令是工具391a99中第二个filename glob搜索`*pipeline*`/`*middleware*`无匹配、exit1；第一个搜索已列出真实send文件。这只是 [navigation诊断](diagnostics.json)，不是产品失败或缺文件断言。所有source pins均在导航前，没有late pin或工具输出截断，metadata手动row打印上限1500且七行均未超上限。[validation](validation.json)记录产品/helper/import/fixture/test/React/UI/timer/model/network/native/Git均0。

[结束检查](ending-checks.json)十个源码/指令pins及46个初始精确命中文档均同字节；Root共享batch本身也与投影时SHA相同。没有自行重核其全部5433成员为当前不变，结束hash不产生新语义。[整理脚本](finalize-metadata.py)、[最后metadata检查](freeze-checks.json)与 [self-excluded receipt](reviewer-receipt.json)冻结本有限包；未修产品，不把本次negative扩大成媒体系统无bug。
