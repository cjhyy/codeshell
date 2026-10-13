# 第十八轮最终整合语义审计

Completed。只读审查，新增测试、native/helper、模型、worker、Electron及网络实验执行均为0；没有修改产品、主报告、构建产物、goal或其他任务。只保存此审计。结论：截至所读第十八轮整合材料，没有发现需要撤回发现、调整分级或否定最终收据的实质矛盾。

审查目录为 `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/`。已读CODESHELL、README、flow-coverage、latest-baseline、reproductions/README、progress、三个作者附录及三个独立审计、automation-quality-round18、fresh-project-quality-round18、两份通用metadata、round18-report-audit.json、三个便携fixture及六份最终日志；按需要核对latest冻结产品相关源码。没有将源码一致当作双基线运行。

## 统计与收据

正式76项=1P1/49P2/26P3，R74/R75/R76各为单项P3，与README、flow及机械QC记录一致。本轮便携增量为3文件8测试165个Bun expect：context 3/82、model 3/46、Hub 2/37，合计3+3+2=8、82+46+37=165。两份通用metadata的对应记录均exit code 0、signal null、skipped 0；六份最终日志分别有对应pass/expect和Completed。

通用总量由第十七轮76文件228测试加本轮3文件8测试，成为每基线79文件236测试；不把两基线运行累加成472个不同测试。Hub两份最终日志各保留12条React act警告，没有隐藏或当作产品失败。context/model的最终收据无对应警告。早期harness失败、作者开发重复运行及Hub的单候选1/17日志均不增加最终测试数。

本轮没有新增native/helper计数。第十七轮owned Bun helper的91手工assert仍属于既有wrapper；不能再次纳入本轮165个Bun expect。latest-only3文件8测试与通用79/236分别列出。automation审计引用的既有2文件7测试38expect、fresh-project引用的既有第三轮5/43均为旧证据，本轮0执行，没有重复增量。

05:50刷新后的round18-report-audit.json记录851个顶层Markdown本地链接、563个源码行号链接、errors为空及两产品tracked diff为空；这是主审已有机械QC收据，本审计没有重新执行链接/全量统计验证。round18-portable-source-sha256.json记录三个便携fixture在两工作区的SHA256分别相同，不是仅按产品源码一致推定运行。原始作者latest-only的模型/Hub记录与末尾主审双基线正式收录段明确分层；context作者本就有两基线记录。附录保留的“候选/待编号”是原始阶段文字，开头正式编号与末尾最终收录已说明，不构成另算发现或否认最终结果。

## R74：摘要用户取消入口

实际ChatView/MessageStream将selection期间composer置hidden，packaging期间退出按钮disabled且handler拒绝退出；普通Stop既依赖busy又在hidden祖先内。fixture在busy=false与强制busy=true两种状态均检查，不靠调用disabled按钮制造缺陷。actual preload的30,000ms RPC timer只删pending/reject，不发送cancel；fixture捕获该真实callback后主动触发，没有自然等待30秒或推进全应用时钟。

动态链实际运行ChatView/MessageStream/preload、Core/ChatSession/Engine/SessionManager和自有内存LLMClientBase；Electron IPC及完整Main/worker为替身/静态衔接。服务级preload.cancel正常，普通可见Stop的supplied callback正常，不能据此宣称摘要期间已有用户Stop。provider覆盖createMessage且不调用withRetry，报告正确补充真实provider有deadline/retry，未称无限运行或所有请求无截止。

迟到target磁盘存在与当前created callback未再执行已证；完整App注册/索引重建只读，不能推出历史丢失或永久不可达。报告明确SessionsView只能发现、无打开按钮，重挂App的磁盘导入仍有origin/root/分页条件，全文搜索不能保证发现只有meta/context_transfer的target。P3范围与正常完成/服务取消恢复一致。与第十七轮上下文正常控制、R03/R41输入回执、R55迟到导航独立；不拆成超时和迟到target多个问题。

## R75：多窗口模型偏好

实际useBucketOverrides在各窗口mount时读map，effect整图save；saveOverrideMap过滤临时bucket后直接写同一localStorage key，无字段合并/跨窗订阅。实际switchActiveModel仅合并本窗口旧map。两React roots/shared MemoryStorage对应生产新窗口共享default session和同renderer URL的源码依据，没有被写成真实Electron双窗实验。

实际ModelPill handler触发选择，native→native不走sessionIndices重绑定，因此fixture的空setSessionIndices不是人为移除正常备份。当前A仍显示内存选择，重挂后fallback，runAfterModelSwitch只记录未来run参数；报告未声称已执行任务改模型、真实provider误用、费用或权限绕过。重新选择恢复、同窗及晚打开窗口保留的正常对照支持窄P3。R25服务端设置整表写、R61全局activeSession导航和R66外部runtime权限实例的修复位置不同。

## R76：异步答案后续运行投影

候选实际HubAuth、HTTP/WS、Headless Host、Core/ChatManager/ChatSession和自动enqueue；Engine、worker transport和stream payload受控。回答通过真实WS而非点击回答卡，实际归档按钮handler动态、UI恢复按钮仅源码；标题正常控制仅owned Cookie predicate，未冒称另一次HubAuth。

原显式run期间archive/export 409正常；原run结束后actual Core答案admission和follow-up busy成立，所有真实Core帧转发，Host没有新外部agent/run ID登记，API running=false。实际HubSessions点击归档，等待服务写marker及onChanged receipt后当前行消失。恢复API清marker与ownedfollow-up自然结束正常。P3影响仅活动状态/运行中归档门禁及当前历史行隐藏，不含丢答案、停止失败、自动删除、输出损坏或完整worker/Engine历史保证。与R73答案未派发lease问题、R72缺restore writer、R39恢复后busy导航独立。

补充只读核对真实Engine终态与marker的关系：`run-finalize.ts:284–314`调用`Engine.persistFinalRunState`；`engine.ts:3866–3884`的finalRunStateFields不含archivedAt，心跳partial同样不含。`run-state-persistence.ts:50–51,68–91`分别用saveStateOrUpdateFields/updateSessionRunState；`session-manager.ts:1583–1604`每次读最新persisted state、核runId后仅合入partial，revision CAS miss重新读取；`:1876–1888`没有将detached全state直接序列化，`:214–219`的stateForPersistence也未删除archivedAt。`Transcript.flush:985–1022`只追加JSONL事件，不写state.json。因此在所核正常owned run写入路径上，没有“终态将整份旧state覆盖归档marker”的源码依据，也不推翻终态前已经发生的归档admission误判。

上述marker衔接是静态反证，未新增真实Engine并发归档/终态实验，不能写为本轮已动态验证所有生成历史/marker终态完整保留。已读主审在Hub附录末尾追加的5个源码链接与只读反证段，措辞保持正常partial路径/无动态完整历史边界，与所读源码一致。原有报告保留fakeEngine不做finalflush的限制准确。父目录EACCES30秒同步mutex仅原始Bun诊断，不混入本轮成功500控制或正式新发现，不据此宣称Node Host已实测阻塞；本轮未扩审。

## 两份旧项反证

automation-quality-round18的0执行口径准确：R44再排队限仍保留的非once任务，已有Core FIFO避免并行Engine但不消除重复提示；R45限明确RPC error且外部网关通知依赖配置/授权，不泛指provider全部错误或普通OS通知；R46承认cronJobId/clientMessageId已经存在，只是详情关联谓词未消费。它们不要求新增实验或改变原P2。

fresh-project-quality-round18保留R37/P2，限本设备刚创建未首轮落盘的freshNative A→断线创建B丢包→重连发送窗口，已保存会话authority保护正常。按钮接线静态，实际controller/handler/metadata动态止于受控accepted，没有真实Engine文件副作用或越权；恢复B新建ACK是源码路径，不冒称本轮点击。与R33背景stream抢绑定及R03/R41回执/离页保护独立。

已追加读取更新后的progress：当前状态05:50为76项、79文件236测试、本轮3/8/165，末尾05:48整合记录保留当时846/558机械QC、05:50记录再次fetch仍a66f及fixture源码SHA相同，05:52归档harness日志去行尾空白保持原始/tmp和错误内容不动。05:48的历史QC数与当前新增5个源码链接后的851/563是顺序变化，不矛盾。README/latest/flow/reproductions/progress与最终QC材料一致，无实质语义错误。

**Completed：建议保留R74/R75/R76各P3；正式新增与执行增量以主审收据为准，本审计新发现0、测试/实验执行0。**
