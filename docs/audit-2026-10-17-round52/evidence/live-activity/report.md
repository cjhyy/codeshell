# Prep101：Live activity 普通数据与展示审查

有限结论：**0 新 formal / 0 candidate / 0 new-related**。所读活动summary、label和实际展示源链未建立新普通反例；不认证所有API/pet消费者、计时生命周期或完整UI。[分类](classification.json)与 [未晋升假设](declined-hypotheses.json)保留。

Root报告当前baseline `00e47e070fdadd6e5882330ba3b0d3962a93a47f`仅作外部上下文；自己的Git为0。实际filename确认目标liveActivity.ts183行、6976 B、SHA `9dc23e4bf020d6cf5d6ed3cf654f8130d6747d13750762e3c9b8bc2ffd310cab`。[initial pins](initial-pins.json)先于正文/行导航；[consumer pins](consumer-initial-pins.json)、[inline pin](inline-consumer-initial-pin.json)、[detail pins](detail-initial-pins.json)也各自先于正文。当前同SHA指令沿用此前CODESHELL217/AGENTS5实际阅读，不把重复hash当新语义。

正文前 [fresh history](history.json)按 [method](history-method.py)扫描全部docs/bugs MD与递归JSON scalar values，纳冻结正式51、排52+，含169个精确archive/_archive成员。共 **5017 = 1479 MD + 3538 JSON**，2348391 strings / 3489788 scalars / 1005953 objects / 85658 arrays，0 parse。path/SHA/filename/old-cause命中 **38/20/57/132**，各cap100保留38/20/57/100为有界 [contexts](history-contexts.json)；未把机器遍历量当人工全读。

实际核40个 [精确对象](coverage-gate-objects.json)的 [compact限定](gate-summary.json)，另读7个原canonical/代表raw rows与2个不同MD filename窗口。R28是库存，R44是incidental/unknown，正式50 frontier原row明确hash-only且没有selected/display；MD的scope-unconfirmed排名和移动端复用建议不是full阅读声明。未建立当前同SHA明确old-full，故进入正文。[gate](gate-decision.json)仍不把unknown/no-row当未读保证、派生claims不当新语义。保留首100 old-cause中另外3个MD前400字符 [选摘](old-cause-selected.json)，不声称读完132个旧因窗口。必要依赖可能有旧读重叠，本次未穷尽量化它们，也不把selected行数当全仓新增唯一覆盖。

本次关键反证纠正了两个看似可疑的方向：

- App1822确实把完整state.messages送入summary，2230传给TopBar，TopBar也继续转发activity。但StatusPopover6–10/22–40/70–76明确此prop只为兼容，旧tool/count/elapsed摘要已移到inline；当前不解构或绘制activity指标。因此不能从summary内部计数变化推出“顶栏计数/计时重置”的可见缺陷。
- summary以最近任意user作边界，未过滤pending/injected。所读普通busy queue路径使用step-gap steer；types1305–1313明确queueInput已不再种optimistic user bubble，steer_injected确认后才首次append。未建立“未消费队列消息已进入state.messages并清掉当前活动”的普通producer。实际确认的injected引导在step边界加入；没有建立旧工具仍running且新inline文本错误的源链，不把手造pending/injected DTO升级为bug。也不据此认证所有steer时序。

实际显示和数据合同是：

- MessageStream820在liveTurnActive时传messages/running给LiveActivityLine。该纯展示组件19–24只消费summarize→describe返回的text，running只控制class；不显示toolCount/turnStartedAt。其他pet/streamGroups文件只导航，未据此宣称计数字段没有其他consumer。
- target37–69按明确last-user边界收集tool，计数、最早startedAt及最后running优先项；agent版本对传入toolCalls做同形投影。没有从正常status字段建立新反例。实际renderer/types1398–1416保留toolName/args/uiVisibility并设running，1483–1491将普通args_delta合入argsLive，1509–1523按result状态转succeeded/failed。这里只看普通DTO值流，clock/身份/权限/sandbox实现不认证。
- describeActivity有无tool时的thinking与有tool时的参数选择；按running选择present/past标签，并压平空白、截断detail、未知tool使用verb+name。必要utils11–19有合法UTF-16 pair边界保护，27–42的basename处理两类路径分隔符，parsedArgs优先argsLive再解析args、失败回空对象。均未调用这些函数或Intl/语言偏好读取器，未用任意坏DTO制造问题。
- 既有liveActivity.test.ts21–94八项声明表达普通turn计数、running优先、thinking、Bash/Edit参数、完成态、argsLive优先、未知tool回退的意图；**0执行**。formatElapsed只读定义，没有clock/timer运行、tick时序或所有格式consumer认证。

[源码清单](source-manifest.json)：**10个语义文件 = 2 full(target183 + Inline26) + 8 selected**，共 **474行 = 400产品 + 74测试声明**，唯一显示851行；所有display/nav/semantic范围分开。[source excerpts](source-excerpts.json)在实际工具显示之后捕获，只存已显示行，不伪称预读pin。source/SDK/native/权限/身份/真实配置与用户数据止于不展开边界，旧失败方向均保持SKIP，不借旧pass。

首次nonzero工具结果是 [diagnostic](first-diagnostic.json)：tool4b09ad exit1来自最后的filename-only exact literal `uiVisibility: "hidden"` 搜索无匹配；同tool此前source sed已成功，0stderr，非产品或测试失败。此搜索不能证明没有hidden producer，未重试扩展或据此制造visibility问题；diagnostic中的command是描述性文本，原完整调用/输出在tool transcript，没有冒称完整raw stdout文件。[validation](validation.json)逐项保留，无截断或late initial pin。

结束 [checks](ending-checks.json)确认12个源码/指令pins全同SHA，原5017历史集合与bytes **0漂移**；结束hash不算二次语义阅读。仅运行自有标准库metadata/hash/search/range脚本，**0产品/helper/import/fixture/test/React/DOM/clock/timer/native/network/model/Git执行**，不修产品，只写exact tmp。[reviewer receipt](reviewer-receipt.json)冻结本包。
