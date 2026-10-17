# Prep99：time.ts 旧全文门槛独立元数据复核

**支持96对time.ts的正文前old-full-source排除；不新增产品语义/问题或全局覆盖。** 原报告与源版本绑定成立。96实际只激活目标time.ts门槛，明确未另行激活test-full；本复核保持该边界。

原canonical `docs/audit-2026-10-17-round13/groups.md:7`明确“完整阅读”time.ts，并把其他大消费者列为选择性阅读。该报告第3行冻结版本与`evidence/groups-source-manifest.json.frozenSource`同为7927a7c8…。原manifest `/files/11`唯一完整path，frozenSha256/sha256同为aa7268c8…；本次仅hash核当前107行/3874B，SHA完全一致，亦与96初末pin一致。`/files/12`的time.test.ts也唯一path、两SHA一致；当前只hash得64行/2342B、cbe5812d…，未读测试正文/声明。

manifest原scope说“Pins do not imply full-file behavioural coverage”，并明确source-only与executed范围在groups.md。它限制行为/运行证明，不否定第7行明确的物理源码完整阅读。此结论基于这份具体MD+canonical行组合，不自动泛化generic reviewMode或任意full字样。测试当前版本绑定虽成立，但96报告及scope-decision显式testFullSeparatelyActivated=false，本次不替其扩大为第二条full或门槛。

原groups.md:9保留time没有动态验证；:36把DST/固定24小时、周一回推及未来/Date范围问题留为未分类，旧recorder-midnight失败路线继续关闭；:43历史clean33-test shard与另一个failed-load shard、0重跑均保留。没有将旧成功或失败变成本次运行，也不认证time算法正确性。87的JSON-only scope-unconfirmed是原有保守时点，不改旧包/索引或总体数。

96包17实际文件与16条self-excluded receipt的精确集合、bytes/SHA全同，12条报告内链均存在且在包内。原scope-decision所摘9行与canonical MD逐行一致；96 manifest四源+两instruction均hash-only、范围/正文/语义0、初末SHA一致，无范围计数矛盾。只独立重核time/test两份产品字节，其他消费者未开正文或独立hash；96完整历史scan及运行声明只作元数据边界复核，未重跑方法/扫描。

本次原报告只选读1–9/32–43共21行，canonical JSON只读顶层限定及两行；0产品正文、0测试声明、0author method/产品/helper/fixture/React/DOM/clock/timer/native/network/Git执行。17包文件与两canonical文件读前pin，结束全同；两产品仅hash也全同。

首自有metadata比较误取不存在的canonical bytes字段，打印2个false标志，命令exit0；原[首manifest](source-manifest.first.json)逐字保留。改按真实frozenBytes后3874/2342均相等，是自有metadata字段适配错误，不是产品漂移或96错误，无运行重试。没有工具失败或截断。

[Inputs](inputs.json)记录初pin；[checks](checks.json)保留精确原位置/行文与收据逐项；[manifest](source-manifest.json)的files=[]、hashOnlySourceRows另列；[receipt](reviewer-receipt.json)记录冻结。原96材料不改。
