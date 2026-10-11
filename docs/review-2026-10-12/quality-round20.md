# 第二十轮最终整合语义核验

Completed。新增测试、原生实验、模型、网络执行均为 **0**；未修改产品、主报告、fixture 或收据。本次仅阅读已冻结源码、报告、JSON、日志，并写此独立审计。

审查目录：`/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/`。产品仍按初始 `84740d56` 和最新 `a66f4ef2` 两个冻结快照区分。读到进度当前状态为新加坡06:33，机械QC收据时间为06:34；本审计未重新执行机械QC、fetch或产品diff。

## 结论

未发现阻止归档的实质语义矛盾。正式编号、分级、通用复现数量、作者与主审运行分账、Goal两项的独立修复位置、R75原生存储补证的组合边界及恢复限制相互一致。两处历史计数的可读性建议已由主审修正，末次重新阅读确认修正落盘；没有未解决问题。

## 阅读范围

已读当前README、flow-coverage、latest-baseline、reproductions/README、latest-reproductions/README、progress，以及goal-sleep-round20、goal-cold-quality-round20、goal-bound-quality-round20、model-native-round20、model-native-quality-round20、priority-quality-round20和r29-priority-round20。

已读round20-report-audit、round20-goal-results、round20-model-native-results，两份通用reproduction-results元数据，Goal作者/主审最终日志及observations，原生存储作者/主审日志、observations和cleanup。相关Goal/Main/App源码、原生存储fixture及正式入口只读衔接已在本轮独立审计中核对；本次未将源码相同误写为执行过两基线。

## 编号与执行数量

- 第十九轮77项为1P1/50P2/26P3；R29从P2降为P3后为1/49/27；再加入R78、R79两个P2，当前 **79项=1P1/51P2/27P3**。R53保持P2，保留边缘分级意见；R37仍是正式P2。R75原生补证没有新增编号或更改P3。
- 两份通用元数据分别有 **80文件、240测试**，条目最终均成功、无跳过。第二十轮新1文件4测试，两个主审portable日志各 **4pass/0fail/72expect/Completed**；与此前79/236相加一致。作者对两基线的重复运行和主审复跑分列，不相加为更多通用测试。
- Goal两portable源码SHA256均为 `b9af1cb777b5fb030839600ced33d4ea369306ee7272127c9f57744d59f490b6`。早期前三份harness失败与第四份4/68历史通过保留，最终收据采用加强guard后的4/72；未把历史68断言累加到72。
- R75原生存储是latest上的owned Electron独立contract：作者31 Node手工断言、主审31另次断言，分别Completed。没有62断言单套suite、没有两个产品基线的原生App运行、没有Bun文件或测试增量。
- 最新功能专项仍独立3文件8测试；仓库现有706文件6286测试与专项通用240测试分账。第十八轮3文件8测试165expect、第十九轮原生各38 Node断言等历史收据没有被第二十轮重写。
- 已读06:34机械QC记载1067个顶层本地链接、705个源码行号链接、errors为空、两个产品tracked diff为空、共同源码SHA一致。这些数字是已读收据，不是本审计新增独立机械复算。

## Goal两项的生产入口与证据边界

**R78/G20-1/P2保留。** 正式StatusPopover Resume经TopBar/App到Main的接线存在；应用重启、worker退出后，在新run之前可以自然处于无live worker状态。Main cold fallback只提交磁盘Goal CAS并回复updated:true，不ensure worker、不sendLine；UI随后显示Pause不表示任务已经运行。正常resident Core Resume会显式drive/queue，故该操作不能仅解释为刻意解除暂停。

动态首例是unbound/legacy持久Goal，使用actual Main callback、App Goal闭包抽取、real preload/reducer/StatusPopover与owned IPC/worker recorder；没有挂完整App、AgentBridge、Electron、WorkerBridgeCore或真实worker。bound且无worker走同一Main分支仅为源码范围，不扩成该场景的独立动态证明。Edit/Pause/Delete和陈旧CAS控制正常，原Goal及历史仍保留。正常继续消息可触发ensure的恢复接线是源码，其他Core正常run控制是服务层；未拼接成完整Desktop发送恢复E2E。

**R79/G20-2/P2保留。** 此项是worker已存在、project-bound session不resident的另一分支。actual Core/ChatSessionManager/ChatSession/Engine及owned memory provider复现，Core queue创建Engine时未收到该bound session的权威WorkspaceContext，Engine在模型前正确fail closed。实际Main Host resolver正常对照能提供context；源码衔接production stdio Engine factory消费同一slice。动态不包含真实worker、整个App或真实provider。

updated:true/paused:false本身不是错误；关键是Resume-specific路径忽略已resolve的Engine错误结果，未恢复暂停或反馈失败。turnCount/usage为0，不能称执行到错误项目、权限旁路、真实模型费用或历史丢失。该项需要Core workspace authority衔接及失败结果处理；R78需要Main cold dispatch，修复位置独立。两项与cron dispatch、Hub approval lease、Hub续接busy投影不同根因。两份独立审计及正式正文均保留这些限制。

## R75原生模型存储补证

本轮证明的是两个已打开owned Electron renderer、同一精确owned file URL、defaultSession下的真实localStorage/storage event/reload contract。A写后B的localStorage可读A且收到事件，但B普通JS旧图未同步；B整图写导致持久存储只剩B；A当前内存仍保留自己的选择，真实reload才读取B-only。晚开的C读取最新图后能保留两项；独立partition D不覆盖默认partition。

原生fixture没有加载产品Main/preload/App/hook/ModelPill/Core/worker。fallback是复制lookup表达式；第十八轮actual React组件/hook与shared MemoryStorage的3/46另证产品状态写法，不能把两层拼成两个真实产品App的端到端测试。相同file URL不推广为任意file路径或dev HTTP origin；当前活窗口模型不立即变化，不声称真实provider错用或费用影响。重选可恢复，因此P3口径合理。

作者与主审原生源码SHA256一致，为 `8cb93bb7c8f304501980dcf040036e3369a310888d1e82880d62144c10811f51`。两次cleanup均completed=true、failure=null、close code0/signal null、privateHOME移除；主审PID事后检查不新增断言。7个Chromium请求均为owned file、无renderer错误。guard、请求收据和零attempt不是OS级网络隔离或全部负向guard探针证明，正文没有这样扩大。首次launch互等的0断言诊断保留，不冒充产品失败或成功次数。

## 优先级与恢复口径

十五项P2抽样没有按“可以重试”一刀切降级。R29正式降P3符合窄legacy迁移等待窗口及投影影响：Main历史源保留，真实可见rename广播恢复；未证明真实运行到错误项目。OpenRecent仍按静态入口表述。

R53保留P2的主审理由与边缘P3意见同时呈现：原folder reviewed安装持久保存错误source，公开Update/CLI Update每次失败，刷新或重开不修复；重新preview+overwrite属于替代更新流程，旧可用版本仍在。这里是分级取舍，不是事实证据相互冲突。未弱化reviewed安装安全门禁。

R18恢复已明确服务级close/mode控制，未冒充可见的一键UI修复。R69/R72服务级恢复、R73取消并重新提问而非恢复旧答案等限定仍在；没有把服务fixture误称完整UI恢复。

## 已修正的小措辞

主审修复后重新阅读确认：

1. model-native-quality-round20结尾明确“本项加入时通用79/236、本项新增0；同轮Goal后当前80/240”，消除阶段数字误读。
2. README后续检查段已推进至第二十轮Goal/current80/240、正式79=1/51/27；验证表补Goal与原生/优先级两行。未更改fixture、历史收据或作者运行记录。

当前progress明确06:23 fetch仍a66f，原工作区其他任务6034df8a保留、未纳入冻结结论；继续到11:00的用户目标没有被此审计当作完成。此文仅完成第二十轮的只读整合核验，不新增finding或产品修复。
