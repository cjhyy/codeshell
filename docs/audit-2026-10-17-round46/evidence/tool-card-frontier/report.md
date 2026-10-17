# ToolCardShell 普通展示数据审查

有限结论：**0 formal / 0 candidate / 0 related**。本轮首位作者直接静态阅读普通展示链，没有运行 tool/helper、React、UI 或测试。

目标 ToolCardShell.tsx 133行、5192 B，读前15:19:13 UTC SHA为4a8597d1e9f055fc855f9b4a601da7e0289df3102a8309ab598e12ccb716f3ea。[历史 gate](coverage-gate-rows.json) 只建立R28/R44库存、ranking/overlay、incidental-path证据，未建立same-SHA full receipt；继续原题，PanelTabStrip备用body0。hash/no-row不证明历史未读。

普通 ToolMessage 的6种status，在Shell映射为running/err/ok/warn/idle，并保留原status title。标题、参数摘要与message.summary结果摘要分别显示；实际Generic consumer把同一message、summary、details节点和epoch传入。preview在折叠时独立保留，展开才显示结果摘要和details。duration只按本次正常producer的非负时长数据考察，没有用任意NaN/坏DTO凑例。

current running被latch直到epoch变化，cleanly completed事件才增加epoch，实际MessageStream→ToolCard/ToolGroup→Generic/Shell有该prop传递。当前注释区分本epoch运行卡与手动打开的历史卡；未用旧设计“每回合折叠全部”一句推翻现合同，也不认证React批处理/时序。没有建立新的普通显示矛盾。[分类](classification.json) 记录有限反证。旧R21关于Browser summary已有failed badge/展开结果的说明仅作为旧反证，不新计related；没有打开Browser/native机制源码或恢复旧失败实验。

[source manifest](source-manifest.json) 8份语义源：2full（Shell133、StatusDot22）、6selected，共383产品语义行、567显示行。另1个PanelTabStrip hash-only，总9pins结束全同。 [initial pins](initial-pins.json)、[chain pins](chain-pins.json) 均在对应正文之前，rg片段只导航。[快照](source-excerpts.json) 是相同SHA阅读后保存，不是第二次阅读。相邻附件、sandbox、drive link、session/native和不需的helper范围均只显示，未纳语义或展审。

[fresh history](history.json) 于15:19:13–15:19:17 UTC扫描docs/bugs全MD及递归JSON value scalars，含档案，纳冻44排45–54：4088=1410MD+2678JSON，1631727strings、2469249scalars，169 exact archive/_archive paths，0parse错误。[方法](history-method.py) 的ToolCard path/SHA命中24/7，PanelTab12/7，cap100；[contexts](history-contexts.json) 完整保存。实际读36个path窗口、7个ToolCard SHA窗口、16个明确coverage元数据行；PanelTab SHA未另读。首打印被截断后从保存JSON补读7–11窗口，无重扫。

[focused method](cause-history-method.py) 的shell-epoch33/cap30、shell-summary29/cap30、activity-latch0；[结果](cause-history.json) 保存30/29/0窗口，实际只读13个指定窗口，未声称所有命中、旧巨scalar或完整历史文档语义穷尽。 [结束检查](ending-checks.json) 保留4088集合无增删，但release TODO由212262 B/f654cd5e…变为219241 B/1ae146ac…；原history SHA未改写。Root随后通知main从c466推进至0b17496707e0f4d679a86a9d8b4c22477093e8a6，仅该文档和一个smoke脚本incoming。这里记录Root提供的上下文，没有读/跑脚本，没有独立Git认证；所有本轮产品pin仍相同。

[诊断](metadata-diagnostics.json) 保留首次7712-token元数据打印在6500预算下截断的原提示、猜streamReducer.ts未命中及head导航界限。真实reducer定位为已pin的types.ts；不是产品失败或重试。测试文件仅rg导航命中，测试语义阅读/执行为0；product import、工具/helper、fixture、UI、native/network/process和Git全0。范围有限，不宣称所有卡片/全仓无bug。冻结文件见[receipt](reviewer-receipt.json)。
