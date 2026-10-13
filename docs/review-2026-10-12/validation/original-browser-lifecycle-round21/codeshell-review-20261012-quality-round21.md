# 第二十一轮最终整合语义核验

Completed。新增测试、原生实验、浏览器/Electron、模型、网络执行均为 **0**；未修改产品、主报告、fixture或既有收据。仅阅读已归档文件及冻结源码、写此独立审计。

审查根目录：`/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/`。读到progress当前06:47；末次机械QC收据为06:49。本审计未重新运行机械QC、测试、build、fetch或任何浏览器。

## 最终结论

**整合语义核验通过，没有未解决的实质矛盾。** 当前80项=1P1/51P2/28P3、通用两基线各81文件243测试、新增Browser各1文件3测试40expect与日志/元数据一致。R80保留窄P3，正式入口、idle条件、实际组件与Host替身、恢复及fail-closed边界均明确。

曾发现一处作者日志被重写为主审初始基线portable路径的归属错误，已先通知主审；主审修正后重新阅读确认。作者原始latest证据和主审两基线复跑现在分别指向正确归档，未改执行数字或fixture。

## 阅读与数量核对

已读README、flow-coverage、latest-baseline、reproductions/README、progress、browser-lifecycle-round21、browser-quality-round21、browser-cancel-quality-round21及取消门禁盘点。读取round21-browser-results、round21-report-audit、两份通用reproduction-results，以及作者原始日志/observations、主审初始与latest日志/observations、三份同源fixture文本。

- 第二十轮末79=1/51/27，新增R80/P3后 **80=1/51/28**。旧79项阶段、R29降级、R78/R79及R75原生补证的历史口径均保留，未重复算新finding。
- 共同元数据逐条只读解析：初始与latest分别 **81条、合计243测试**，code均0、signal均null、skipped均0。Browser各一个条目、tests=3；latest条目archiveLog正确指向其独立日志。
- 主审初始日志3pass/0fail/40expect/Completed，14.61s；latest日志同为3/40/Completed，14.52s。各observations.baseline分别是primary初始工作区与latest工作区，均记录两次实际status轮询、networkCalls=0/subprocessCalls=0。作者原始latest单独日志为3/40/Completed，14.46s；没有把作者与主审三次运行相加。
- 上轮80/240加本轮1/3得到 **81/243**。没有本轮native/helper增量，latest-only仍3文件8测试；原有706文件6286测试及先前独立原生实验未与通用专项混算。
- 只读比较primary portable、latest portable、original作者fixture的完整文本，三份逐字符一致。已读结果JSON/QC所记SHA256均为 `ef376b426f71dc862ec7ce2f6ac0861997fcd1f21a7883d49d7e015c6e20c8f0`；本审计没有重新执行测试或哈希程序。
- 已读06:49机械QC记载1111个顶层本地Markdown链接、721个源码行号链接、errors为空、两个产品tracked diff为空。此处是引用主审收据，不冒称新增独立机械扫描。

README开头/当前结论/表R80/第二十一轮段/验证表/后续检查，flow当前表及轮次段，latest当前累计与末段，reproductions轮次说明和progress当前状态均一致。旧轮中“当前79/236”“当前80/240”等保留其明确轮次语境，不当作最新总数。

## 影响、分级和去重

R80限定已知且当前窗口拥有的任务，在普通任务BrowserPanel内合法配对、grant未过期，Native transport在闲置期间断开，尚无fresh hello或browser dispatch。生产Panel的2秒轮询已读到connected=false，banner和按钮仍只按granted显示当前“正在使用”及断开，无erroralert或直接新配对入口。

不是仅以granted字段判错：历史permission可以保留，但UI中“正在使用”及同一Backend将断线认定grant ended的执行门禁共同支持反馈缺陷。也不是正常idle使用措辞、所有浏览器窗口或某个未经验证的OS关闭事件。Native server close不清Backend grant、extension断线清本地grant且无自动重连的生产可达性为源码衔接；没有真实Chrome/relay关闭实测。

实际动作正确NEEDS_HUMAN并清旧grant，Native browser.action=0，下一Panel轮询恢复连接按钮；用户可显式断开再配对。故P3合理，没有升级为安全越权、错目标执行、数据丢失、永久不可恢复或断线仍能操作Chrome。修复仍须保留endedGrants marker、exact tab/grantId/owner门禁，不能静默回落另一browser target。

R42为Cookie新增ID覆盖，R22/R23为Panel项目身份，R57为后台Bash下载清理；R67虽也属状态反馈，但其LAN成功广播遗漏与本项正常poll仍忽略连接状态的根因不同。现有action/queued disconnect tests触发后置清grant，不能替代idle poll控制。未发现重复根因。

## 实际与替身、恢复证据

实际层是React/MiniDOM中的BrowserPanel、Toast/i18n/hooks、actual preload、从生产Main抽取且未改的authority helper及Chrome callbacks、actual ChromeExtensionBackend。按钮调用为真实组件onClick闭包，不是Electron原生鼠标输入。新空白tab路径没有webview。

Electron IPC/contextBridge、known-session/window-owner目录、Native transport连接状态/tab响应、built-instatus、portprobe和installation descriptor均为owned内存适配。Main完整注册环境、AgentBridge、App、Chrome Native认证/framing、relay、debugger、worker/model/CLI/站点账号均未运行。guard和0counter记录没有被扩写成OS级网络隔离或真实浏览器端到端验收。

动态恢复是 **actual UI撤销→owned fresh hello→actual UI开始配对→合法新grant** 的组合，以及断线后actual Backend action拒绝并触发UI修正。**fresh hello或TTL单独清旧grant仅为源码/既有测试支持，本轮没有分别新增动态case。** 正式附录及主审追加节明确这一层级，未把组合中包含hello写成单独hello恢复实验。

新grant的listTabs走actual secureBridge `chrome-extension-runtime.ts:435–444`→currentTab `:316–321`→requestForGrant `:523–547`→owned Native tab.get；因此是高层只读RPC恢复，不能简写成直接枚举grant缓存。tab.get响应内存，不代表真实Chrome navigation/click、登录态或debugger重附着成功。正式README/flow/结果JSON/专项附录/两份quality的表述一致。

取消/child/owner关闭盘点新增执行0，现有测试仅用于覆盖盘点；parent Stop与已派发Main动作的取消关系保持未验证，不并入R80、不编号、不增加测试或finding。

## 失败诊断与已修正归属

原始first.log为0pass/3fail/17expect，失败为不存在的按钮标签及另一分支detail期望；最终fixture修正文字期望后3/40。失败诊断完整留在original归档，不作为产品新缺陷、通过次数或额外测试计数。

原browser-cancel-quality的“作者最终日志”曾指向primary portable日志，而该observations明确是主审初始84740运行。主审现将作者source/final.log/observations/Main JS指回 `validation/original-browser-lifecycle-round21/`；正式附录作者段也指original，末尾主审追加节分别链接primary portable和latest archive。唯一重跑命令保留正式reproductions路径并注明是便携命令、原作者绝对/tmp命令见原始归档。重新阅读确认修正落盘，归属错误已解除。

两份独立quality保留候选阶段的79项/建议P3语境，正式附录明确收录R80并追加主审双基线收据，未将当时只读审计写成后续root执行。产品审查截止11:00、06:23已知origin仍a66f及原工作区其他任务6034df8a保留的进度边界不变；此文仅完成第二十一轮整合核验，不管理目标或调度。
