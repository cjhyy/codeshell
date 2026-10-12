# 剩余模块报告独立证据复核

复核基线：CodeShell `62a58ac8702835f848108e152234a6bdd6c3eb3f`；Panel Apps `aabba34ca94f7081fd7de4e20c52443f08f36d5e`。本轮只读报告、最终日志摘要和少量明确源码定位；没有运行产品/测试，没有新增复现、没有检查探索权限 payload，没有修改 root 报告。新增执行计数为 **0**。

已核对 `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/core.md`、`/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/coding-tui-chat.md`、`/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/hosts.md`、`/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/video-studio.md`、`/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/quant-job.md`、root 的 `root-and-video-download.md`，并追加 `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/design.md`、`/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/core-lifecycle.md`，及下面列出的对应最终日志。本版33项只汇总上述八组；Pet专项等未交给本次审计的材料不包含在内。

## 必须修正或保留限定的地方

1. **CLI C1 从 P1 调为 P2。** 证据确立已经接受的 Codex turn 在 transport exit 后不结算，200ms 只是观察窗口，源码证明没有 exit 结算路径。影响是单个 runtime/session 持续 busy、Stop失败，可关闭 runtime 恢复；没有证明未提交文件丢失、反复不可恢复数据损坏或跨会话广泛故障。按旧 R18/R31 等可用性分级，P2 更一致。
2. **CLI C1 两处行号需修正。** `codex/runtime.ts:224` 实为拼接 initialContext 文本，activeTurn 创建应指 **218–220**；`:303` 是 for-loop 结束，settle 应指 **299–301**。`app-server-client.ts:272–281` 的 pending-RPC-only failAll 定位正确。
3. **CLI C2 可保留 P1，但应收窄“永久丢失”。** 两个实际 adapter callback + 实际 durable queue 的正常/满队列对照，已证明合法输入未被队列持久接受，却成功 ACK，应用没有可重试副本。这是静默接受语义破坏，满队列/存储失败时会持续丢消息，P1 可按正常入口静默数据丢失保留。不能表述成平台聊天原文被删除、无法人工重新发送、或已实测真实平台永不重投；SDK ACK本身为替身，平台重投时序未执行。建议标题/影响用“成功ACK但应用未持久接受且没有应用内恢复副本”。
4. **Core C1–C3 继续使用当前明确层级，不能升级成完整安全边界验收。** C1 为可信 hook 组合；C2 为process-global registry/fake child handler，原执行使用 bypass，加默认allow源码链；C3为registry reset/spawner seam，不是真进程重启。未重跑权限方向，更未执行命令/模型。原10-test运行在root package gate之前，不能称 clean-dist/post-gate全部通过。
5. **Core C1 行号由约数改为精确定位。** 本轮只读检索确认 executor 中 MCP gate 在 **267/296**，pre_tool_use emit在 **364**，updatedInput赋值在 **382–383**。报告原“~260–315/~369–410”可以作为范围，但主发现应给精确anchor。没有读取或重试权限探索夹具。
6. **Video 仍有6个原生画面测试失败，不能用“全绿”汇总。** 日志确认都为画面渲染超时；尚无正常环境控制证明是产品回归，不能再计6个新bug，也不能称实测编码视频输出正确。倒放项证据是实际共享 evaluator 无 picture layer，preview/export生产消费者静态衔接，未验证编码MP4 pixels。P2可保留，但不能把音频tick0观察扩成音频缺陷。
7. **QJ-04 已证明业务状态/compact快照丢旧岗位，最终持久写入为替身。** 不能写成已在真实Host磁盘删除所有旧记录。QJ-02 为原文生产函数+VM/fakeHost，不能称真实Electron端到端跨项目写入。QJ-01区分既有账本和第一次建账；首次建账重试有 `initialLedger` 冲突保护。
8. **旧原文/新汇总编号需带scope。** Core C1、CLI C1同名；Video V1与VideoDownload V1可能混淆。最终主表用稳定全轮编号或scope前缀，避免把同样例跨报告再计。

除 CLI C1 外，本轮没有必须降级/撤销的发现。CLI C8 限定exported ChatGateway/DeliveryQueue默认或配置 `maxPerTarget=1`，不能套到当前刻意提升并发的Mimi Chat CLI；源码queue注释确实声明per-target ordering，因此不是单凭调用者幻想串行语义。

## 合并与旧86排重

| 新发现或组合 | 复核结论 |
| --- | --- |
| Core C4 可见失败前缀 + 已知failed-attempt token未计Goal | 继续算1个provider重试发现；第二个影响是补强，不能新增第6个Core候选。修显示不自动等于修计费，交接中保留两个验收结果。 |
| Slack / DingTalk ACK | 共同dispatchSafely吞拒绝+成功ACK，按1个C2；不是2项。Lark无动态ACK证据，不扩渠道集合。 |
| CLI LSP C4/C5 | failed-start ownership/error 与ready/liveness两组可独立；同组多个现象不再拆。 |
| CLI Notebook C9/C10 | valid-source decoding失败与replace丢已有metadata/id是不同根因和修复，可独立；不能把缺id/丢metadata再拆两项。 |
| QJ-01、VideoDownload V1、旧 R03 | 都有ACK不确定，但产品代码分别是交易append、Panel agent查询key恢复、Web聊天intent；不同root cause/验收，可独立。每组多个失败时序继续算1，不靠同类标签合并不同应用。 |
| QJ-03 / QJ-04 | 同批去重与固定容量静默截断独立，第二项不依赖重复；可分别修复。 |
| CLI C1 vs 旧 R18/R15 | 已接受turn的transport结束不结算，区别于CLI启动失败残留句柄、后台后续消息不推进；独立。 |
| CLI C4 vs 旧 R36 | ChildProcess spawn error无listener与worker stdin EPIPE为不同source/对象生命周期；不是仅因都unhandled error就合并。 |
| CLI C6 / Host N01 vs 旧 R31 | Claude runtime未wait/escalate，Chrome native unauthenticated socket未track，Panel Hub进程退出过早，三处独立owner/cleanup实现。只用相同process/close标签不能合并。 |
| Host N01 vs 旧 R80 | graceful quit等待未认证TCP peer，区别于已配对Chrome失联后的UI状态；独立。 |
| CLI C8 vs 旧 R63 | 后来消息越过retry vs urgent被普通窗口等待堵住，为不同队列、方向和promise；独立。 |
| Arena A1 vs 旧 R59 | git_show对象引用放在`--`后 vs首次提交diff无父range；独立。 |
| Optimization O1 / Core C4 vs 旧 R45/R78/R79 | 各自为Lab冷stop终态、provider内部失败usage/输出，与自动化失败宣告completed及Goal冷续接派发问题不同。 |

旧86排重依据只读旧 `README.md` 和 `priority-and-coverage.md` 的具体trigger/root cause，而非仅按模块名或症状归类。没有发现需要与旧86合并的同source/rootcause项；旧“独立Panel业务未覆盖”仍适用。本轮没有复审旧86在新基线是否已修复。

## 分级与局部计数

这八份材料当前共 **33个候选**：Core5、CLI/Chat/TUI10、Host1、VideoStudio1、Quant/Job4、Root/VideoDownload3、Design7、Core生命周期2。把CLI C1改P2后，局部建议分布为 **1 P1 / 26 P2 / 6 P3**。这是截至本版材料的算术核对，不包括Pet等未交给本审计的材料，也不应与旧86直接拼成“新全面覆盖总数”。

- Core C1–C5：P2保留，边界如上。
- CLI C1：P2；C2：P1（ACK范围如上）；其余C3–C10：P2保留。
- Host N01：P2，准确影响是“已接受idle未认证peer保持连接时，正常quit未结算”；不宣称远程拒绝服务或不能强退。
- Video倒放：P2，限定共享evaluator/生产调用链。
- Quant/Job：QJ01/02/04为P2，QJ03为P3；本审计作者就是这组原作者，**不将本轮对该组的复读包装成第二个独立作者背书**。
- Root：V1为P2；A1/O1为P3。Arena未加载、Lab默认关闭及冷stop窗口范围已在分级中考虑。
- Design：D1–D5为P2，D6/D7为P3；如下限定。
- Core生命周期：CL1为P2，CL2为P3；warning evaluator仅候选不计。

## 日志与执行计数核对

| 执行组 | 已见最终收据 | 不能怎样相加/外推 |
| --- | --- | --- |
| Core原夹具 | candidates.log末尾10 pass/0 fail/33 expect，Completed 10/0skip | pre-gate；其中provider3项后续重跑不产生额外唯一测试。 |
| Core后gate provider rerun | 3pass/7filtered/0fail/9expect；runner显示catalog10/7skip | 不能写“后gate 10通过”。 |
| Core后gate accounting | 5pass/0fail/18expect，Completed5/0skip | original+accounting为2文件15唯一用例；execution-pass总量可18，但不能称18唯一用例。 |
| CLI guarded Bun | core-run3.log 7pass/0fail/37expect，Completed7/0skip | run1=5、run2=6是历史版本，不能追加。 |
| CLI native | native-run3.log 9正常/故障观察+cleanup1，livePids=[] | 不是10个Node:test/Bun tests。 |
| CLI actual PTY | Esc/ctrlc/input最终3次成功执行；日志raw=true→false | Ctrl+C“pending”正是缺陷，不是成功cancel。Esc输出hostStillRunning=true是夹具尚在输出cleanup前；应引用outcome=cancelled而非声称那一行host已经退出。 |
| Host N01 | native-stop.log 4条失败/正常/释放后记录，idle1252ms pending、释放后settle | 不是4个新bug/4个框架tests；只1项source fixture。 |
| Video默认catalog | 1139=1136pass+3skip；native voice6=5pass+1skip；workspace5pass | 总1150=1146pass+4skip；不是1150pass。 |
| Video额外native | 73=67pass+6fail、duration230368.806167ms | 不与默认套件称“无fail”，6项为环境未定性的E2E边界。 |
| Video reverse / concurrency | reverse-boundary.log正/倒/回正/trim/3frame值吻合；mix12round均ok/reused | 没有统一Node:test计数，不把12轮×3请求变成36测试；cache假说是阴性结果，不算发现。 |
| Quant/Job | baseline211+79，custom10pass/48assert；35+1文件 | 共300 Node tests、另16脚本；16脚本无统一expect计数。不是完整官方两suite全部执行。 |
| Design | run9为11pass/0fail；existing-run1为19pass/0fail | 共30唯一用例，8个实际app browser case+3个纯模块case；四组PRD heading为一个case，不能计为4 tests。run1–8为调查历史，不追加计数。 |
| Core生命周期 | lifecycle-final11pass/49expect；normal-controls-final79pass/188expect | 9文件90tests/237expect，0fail/0skip；初9-test与原79无telemetry运行不追加。warning/passed/failed3项是控制用例，不是3个新bug。 |
| Root候选 | root-candidates.log 2pass/7expect，Completed2/0skip | Arena/Lab合计2，不加成额外3项。V1单独2个浏览器scenario非同框架test。 |
| Root既有control | control-shard326/923expect/29files；VideoDownload147；select5；build66 | control-shard含Pet专项，与后续Pet全包会重复；没有测试ID去重表前不报告全轮“唯一tests总数”。 |

已核原始日志：`/tmp/codeshell-remaining-core-review/{candidates,providers-post-gate,providers-accounting}.log`、CLI `core-run3/native-run3/tui-escape-run2/tui-ctrlc-run2/tui-input-run3.log`、Host native-stop.log、Video offline-suite/native-suite/reverse-boundary/mix-concurrency.log、Quant baseline/review.log，以及root归档的control-shard/root-candidates/video-download-controls/panel-select-controls/panel-build-controls.log。

## 交付建议

只需修正CLI C1级别与source anchors、Core C1精确anchor，并保留原文的测试/平台边界。汇总表不把过滤用例、历史run、native observations或阴性实验累加成唯一测试。最终档案确认 `.log` 原始证据被收进交付（普通rg文件清单因ignore规则可能看不到已存在log）；本审计没有替root添加/stage文件。

## Design追加复核

读了最终run9、existing-run1日志，目标源码、README功能说明，以及字体/PRD夹具原文；未执行任何夹具。结论为 **7项保留（5 P2 + 2 P3）**，不必撤销或升级。

- **D1/D2 P2：证据对应实际产品handler和浏览器编辑。** D1拒绝事务后12→11页、dirty=false、实际下一次save丢页，catch的7457–7461确实只恢复design并由未回滚cache重建；无需把save失败的静态可能性加入发现。D2在3983只检查primary read后的revision，3986异步indexed resolver后仅检查workspace epoch，3989赋值；primary-delay正常对照与part-delay故障对照隔离了缺失第二次revision检查。两者不是旧R03的Host ACK恢复问题。
- **D3 P2：保留为frontend交付内容丢失。** 生产capture确实保存full `textSource`，exporter373–374只输出截断`text`，而CSS315–328没有ellipsis mapping；普通文字正常对照成立。源`.codesign.json`完整保留，不能声称源文件被破坏。README143–145的deterministic frontend能力和159–163的editable/ellipsis import契约使它不只是格式风格建议。完整capture→write链仅静态追踪。
- **D4 P2：是已有project font被忽略，不是新增字体功能建议。** 文档合法支持fontRef，生产`generateFrontendFile`4405先加载引用资源并在4422–4424把`resourceDataUrls`传给exporter；exporter319仅读node.fontFamily、377只消费imageRef、428–445无字体descriptor或`@font-face`输出。已给可用字体bytes仍被无声丢弃，属当前HTML导出的映射遗漏。真实字体加载对照成功（fontCount0→1、字符串202.6875→202.59375），结构性缺字节足够，不能夸大为大幅像素差异；SVG控制只证明小合成数据URL被序列化，不证明该合成font能渲染。当前字体case保留P2，但标题/影响限定“使用项目字体的frontend HTML”；不应扩大成所有export的字体失效。
- **D5 P2：第一token分支明确无长token拆分，真实Inspector中文resize保留整行19.2高度，后置long-token正常对照成立。** 换行符被折叠只是该case附加纯模块观察，不再计第二bug，也不扩成所有文本脚本/emoji测过。
- **D6 P3：完整Undo后deep-equal saved content但indexed dirty，单文件对照saved。** 保留假脏状态/多余提示；没有内容丢失证据，不升级P2，且与D1事务失败cache回滚是不同rootcause。
- **D7 P3：为明确parser契约错误，不是对模型设计偏好的意见。** `product-brief.mjs:9`已经显式列出`非目标/non-goals/out of scope`为constraints aliases，却被4/6的短子串先匹配；29–32为准确错误位置。run9特意有独立`需求`section，因此不是零requirements fallback混淆；三种非目标heading分类错误、约束heading正常。prompt176–177/185–194/201–202确实按错误结构输出。否定文字本身仍保留，无法据此宣称Agent会实现禁做功能；P3正确。

D3/D4分别缺完整文本与font资源映射，可独立修复，不合并；D1/D6为失败事务回滚与saved-equivalence两种不同cache状态机，不合并。旧86没有同source/rootcause的Design项。最终run9的8 owned Chrome PIDs均退出，liveChromePids=[]。调查run1/2的browser-cache/fixture-refresh失败及run6的SVG预算拒绝已完整披露，不是产品回归，也不作额外tests或findings。

## Core生命周期追加复核

已只读核对最终报告、`lifecycle-final.log`、`normal-controls-final.log`、明确源码anchors和夹具生产入口部分。结论为 **CL1 P2、CL2 P3保留**；warning evaluator继续不计。无新增执行。

- **CL1：受理的答案仅存event，冷恢复实际请求丢输入。** `RunManager.ts:298–303`只queued/event/enqueue；实际`EngineRunner.ts:248–251`只传原objective与cwd/sessionId，没有消费resume answer。最终log确实同时记录原objective请求和含新answer的run_resumed event；warm control为真实suspended handle收到exact answer。CLI `commands/runs.ts:219`创建新manager，243–246将`--input`传入，生产静态可达；无需真实模型就能确立输入传递断链。限制为SDK/已实现CLI managed-run，不扩大到当前普通Session驱动的Desktop自动化。不同于旧R12多题控制消费、R78无派发、R79缺WorkspaceContext，以及新Core C3角色限制恢复；此处正确dispatch但遗漏新输入，独立计1。
- **CL2：生产入口没有共享dream在途守卫，P3证据足够。** `run-finalize.ts:225–235`对每次eligible finalization fire-and-forget，`auxiliary-pipeline.ts:148–198`每次new orchestrator而没有root级claim；报告附实际AuxiliaryPipeline+Transcript+memory/cadence文件的并发收据。两次captured[6,7]、第八session在途计入、success后2→0，single control保留1，符合`memory-orchestrator.ts:418–426`重叠snapshot消费和`auto-dream.ts:171–180`分别减量的根因。仅重复辅助请求及next-cycle错误计数，不外推内存正文损坏、真实付费、永久停用或多进程实测。旧86无同源dream/cadence项，现有代码关于以前修复increment与single-flight reset的注释不等于此重叠claim已经修复。
- **Evaluator warning：holdout正确。** 已证明warning→failed，但没有built-in warning producer或确定nonfatal业务承诺，不能凭enum名字升格。报告将3个warning/pass/fail用例计入11test、却只把CL1/CL2计入finding，计数一致。

生命周期final guard两组均记录denied0/allowedOrigins=[]、无真实Engine/model/parser child；90tests/237expect是最终9文件日志可支持的局部执行数。它与root既有control-shard或其他报告若有相同existing files，需要按测试ID去重后才能称全轮唯一总数，本审计不输出全轮tests累计。

## Root最终队列核对

只读核对root draft `README.md`、`findings.json`与生命周期`INDEX.md`。JSON为33条、33唯一N编号；README为33条对应行，逐条ID/priority一致；按报告分组为CLI10/Core5/Design7/QuantJob4/Core生命周期2/Host1/Root3/Video1，分级为1P1/26P2/6P3。所有33条primary source文件存在、行号在有效范围内、专项report存在；这是报告结构/locator校验，不是重复执行产品测试。

Root已经把CLI C1/N14降P2，ACK描述保留平台原文可重发、Core seam边界、Video6timeout和未验收MP4、Design导出/字体限定、Lab冷stop窄窗口、不同shard不相加、旧86不声称新基线复测，均与本审计一致。排序上先消息持久接受、再预算和数据完整性合理，没有发现需调整33项计数的合并问题。

当前只剩两处编辑性同步：root已告知会将N13/N28的originalId及链接标签`L1/L2`改为原报告`CL1/CL2`；N13范围可写“RunManager SDK及TUI managed-run CLI”，当前“限RunManager SDK”较原证据过窄，避免漏掉生产CLI reachability。N13等级仍P2。Root负责改汇总，本审计没有修改其文件。
