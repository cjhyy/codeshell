> 历史阶段稿（08:19静态及作者第二次执行后的补记）。下文83/247、未编号、等待root仅指当时状态；随后root双基线各1/17完成、正式R84已收录。当前结论与最终整合核验见[第24轮报告](legacy-history-round24.md)及[最终质量核验](quality-round24.md)。原稿字节保存在[独立阶段原稿](validation/original-legacy-history-round24/independent-stage-quality.md)。

# 第24轮：旧 paired native 图片历史的独立只读反证

审计时间：2026-10-12 08:19 SG（clock 实际 UTC00:19:18）。审计者 `/root/goal_sleep_review`；新增 fixture、原生、CLI、模型、网络执行均为 **0**。本文件仅为 `/tmp` 独立审计，不改产品和主报告，不提前赋予 R84。

结论：源码支持一个**窄 P3 候选**，可进入已审隔离 fixture 验证。合法旧 paired native `chat.send` 图片 turn 未带 `displayText`，且从未发布 output journal；当前客户端正常协商 outputJournal:1 后进入既有 legacy history 分支，旧 reader 把 model-facing `<attached-image-paths>` 和提示作为用户正文，附件名称/数量没有成为显示 summary。真实 authority 的可达条件和 hook 消费均有生产接线，未发现“当前旧会话一律被门禁拒绝”或“该分支只是死代码”的反证。但此阶段没有运行结果，不能将源码判断写作实际 authority 验收或完整设备端到端复现。

## 范围与材料版本

- 当前源码只读基线：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，a66f4ef291f304ee4df9da8095a90671d9a8f140；去重报告来自 primary 的 `docs/review-2026-10-12/README.md`，当前正式83项、通用83文件247测试。
- 已读作者 `/tmp/codeshell-review-20261012-legacy-history-round24/PLAN.md`、prepared fixture 与前置 guard。最后已读的 fixture SHA为 `338c90fd5af72029731105eb5f26bcc8372f862373475b90d9c7da4960ff3ccc`（263行，新增 finally revoke）；guard SHA `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`；PLAN SHA `37f0ec9d447ede1e73febe3ab8196c23e9d1aae850222e803acce68d6ea8454e`。SHA只标此审计所读版本，不冒称已经执行或后续最终冻结版本。
- 作者使用实际 stage/prepare/content/Transcript writer；实际 Main dispatcher、恢复服务、reader、React hook 和 Workbench；WebSocket、认证/authority stamp 和 controller 外壳为受控适配。显式 Core dist 与 source/barrel 采用范围是源码审计声明，`Bun.resolveSync` 仅是地址解析收据，不能推成实际 module cache 或统一模块图探针。
- 当前 guard 先校验 maintained private HOME，再安装 maintained exact-origin guard，然后连 dummy origin 也拒绝；主动覆盖 fetch/http(s)/net/tls/dgram/WebSocket/Bun网络及 child_process/Worker/Bun spawn。它是进程内 guard，非 OS sandbox。本审计不启动它或导入产品模块。

## 合法 producer：不能仅凭 displayText 可选就省略

最初 prepared seed 省略 `displayText` 并不足以证明正式可达：当前和 prejournal `run-session-open.ts` 都会持久化 `options.displayText?.trim()`，若实际 Host 总会发送干净正文，就只能报告附件 summary 遗漏，不能报告 wrapper 正文暴露。

该门禁已由真实旧 paired native producer 收窄解决：

1. 独立亲读 `git show c9b1d95979a0ca12faedeba9fadf81e8ddda680f:packages/server/src/mobile-remote/mobile-chat-turn.ts` 的94–108，实际请求仅 task/cwd/sessionId/project/root/clientMessageId/attachments/permissionMode，没有 displayText 或 injected。当前 `mobile-chat-turn.ts:95–106` 同样如此。
2. prejournal `protocol/server.ts:2020–2038/2195–2217` 将缺失的 `params.displayText` 归一为 undefined、`params.injected===true` 为 false；prejournal `chat-session.ts:509/515` 直接透传。当前对应 `server.ts:2021–2039/2196–2218`、`chat-session.ts:514–527`，没有从 task 自动补干净 displayText。
3. 当前 `run-session-open.ts:153–156/189–192` 把 content 和上述 metadata 写入 Transcript；prejournal 同字段一致。修订 seed 显式写 `injected:false`、clientMessageId、`displayText:undefined`，符合该特定 producer，而非任意删字段造例。
4. 独立 `git rev-parse` 已核 run-image-input.ts 的 prejournal parent 与84740 blob同为 `4a28a57c65b7748820c207b3ece2c7031687865f`；input-attachments.ts 同为 `c49f0dd6e9db2876111bd0473b9812af9af4478b`。当前 `run-image-input.ts:194–224` 确实用实际 staged path 生成 wrapper 与 image blocks。无需手造 XML。

因此应限定**旧 paired native chat.send**，不扩为所有 Desktop、TUI、Room 或 external runtime 旧输入。fixture 的 `origin:"mobile"` 与此限定一致。没有运行 Engine、AgentServer、真实模型；writer/helper 重建格式与真实旧 producer 的关系由上述源码证明。

## 正式门禁与兼容分支可达

真实 Main authority 不以 journal 缺失为拒绝条件：

- `mobile-remote/output-recovery-authority.ts:9–24` 要求 safe ID、非symlink真实目录、有效state、非ephemeral/子会话/pet/incomplete，以及可用 workspace authority。它没有要求 outputJournalIdentity。
- `session-workspace-service.ts:210–244` 对旧未绑定 Session，验证已注册root若存在时的身份、普通目录及 Git 可用性；`:266–289` 只吞明确 not-a-git-repository 错误，合法 nonGit目录仍得到 rootStatus=ok。不是所有 Git 错误都被吞。
- 对 special no-repo cwd，`ProjectStore:163/739–740` 与 `output-recovery-authority.ts:47–51` 用当前 CodeShell HOME/no-repo身份允许无注册project；普通任意未mounted目录不能借此越过authority。其余目录/workspace inode、state revision和root存活条件见authority`:27–69/92–133`，必须持续成立。
- `mobile-remote-orchestrator.ts:118–127` 真实接入该authority、exact authenticated viewer/device、Bridge snapshot；journalRequired仅已知 external runtime，旧native为false。
- `MobileOutputRecovery:152–185/198–242` 在select及每次page读前后重验认证、当前selection、Session/recovery ID和authority stamp。owner是实时镜像的约束，不是旧native disk history必须存在live window/worker的门禁。

所以普通、有效、未被删除/替换/撤权、从未发布journal的 no-repo native旧Session具有源码可达性。**fixture用受控stamp/auth seam，不调用上述真实authority**，因为真实authority会启动本地Git probe；这不能算动态权威验收、真实mounted-root或真实认证传输覆盖。

兼容链不是手动调用未消费的内部 helper：

1. `handle-client-event.ts:241–250` 先等待正式 recovery selection，成功后才更新当前选中Session（`:299–315`）。
2. `MobileOutputRecovery:232–268` 用实际 journal reader 并携带snapshot。`mobileOutputRecovery.ts:51–87` 对没有journal pin、cursor、pending input、required producer约束的 unavailable返回null。已发布journal丢失/knowncursor或coverage缺口会失败/等待，不得把这些情况拿来造legacy fallback。
3. `mobileOutputClient.ts:190–193` 清recovery selection并调用legacy；`useRemoteApp.ts:538–541` 真正发送 `session.history`。
4. `handle-client-event.ts:546–563` native分支调用真实 `buildSessionHistory(getSessionTranscript)`；external runtime被明确排除。
5. `useRemoteApp.ts:657–680` 接收当前boundSession的history.ok并replay，`:213–214` 逐个经过reduceStream；不会只把该回复缓存而不显示。

## 差异根因与正常显示对照

- `transcript-reader.ts:153–159` 仅将content的text块拼接；`:254–263` 的user分支优先displayText，否则直接textOf(content)，没有恢复attachment summary。`getSessionTranscript:535–551` 正式读取当前sessionsRoot下的真实、非symlink transcript。
- `mobile-history.ts:34–35` 进一步只构造 `{type:"user_message",text:item.text}`，也没有附件字段。
- reducer入口虽调用 `projectOutputUserEvent`，但 `userMessageDisplay.ts:153` 仅处理 `session_user_message`/`steer_injected`；旧history合成的 `user_message` 不进入其 transcript metadata投影。`streamReducer.ts:649–680/713–715` 直接保存文本，只有event本身有attachments才显示summary。
- 真实 `DesktopApp.tsx:30/464` 使用同一个useRemoteApp并把app.chat交给Workbench；`Workbench.tsx:622–637` 原样渲染item.text和可选attachments。因此不是fixture绕过另一层真实 UI清洗。
- 正常journal的legacyBase走 `output-recovery.ts:245–248`→`transcriptReplay.ts:132–140`→`transcriptUserDisplay`。`userMessageDisplay.ts:97–145` 去掉同wrapper/model hint并恢复图片名称/MIME/数量，不携带base64用于显示。

计划的现代对照是在第一次旧history读完后首次创建journal，保留同一条旧user message再读；不删除或损坏published journal/pin。此对照证明两个既有显示投影的差异，**不是生产repair UI**，也不应建议用户为了恢复显示额外发起收费模型请求。普通正文、assistant答复、文件bytes不变与无base64显示是合理正常控制，运行结果尚待父审收据。

## 契约、TODO、TTL、删除与去重

`mobile-remote-send-image.md:213–217` 明确：离开页面可只保留名称/数量；历史无summary也至少隐藏内部path block并显示“图片附件”；第一版不要求历史下载API。候选只要求这最低显示契约。`mobile-output-journal-delivery.md:86–87` 和 `TODO.md:29` 的旧peer/无共同cursor保守降级与`:123–125`的任意historical imports后置，并不授权当前已支持的native history分支把model标记当普通user prose；但不能把它扩大为任意历史格式完全恢复承诺。

`attachment-service.ts:122–123/448–457` 是draft24h/sent30天retention，按sentAt/createdAt选择；`:437–445` 的显式Session cleanup可合法移除附件。5分钟Mobile upload ticket（`mobile-remote/mobile-upload-service.ts:12`）及browser objectURL生命周期是另外两层；成功后finalize只移除临时upload记录和文件（`:359–362`），不证明sent文件已过期，也不能要求历史thumbnail/objectURL永久可用。此候选应要求仍有效Session和合法history，使用保留originalbytes的控制；不称原件丢失、下载损坏或删除后复活。真实authority会拒绝已删除、替换、ephemeral或失效root，不能用该fixture的controlledstamp推广删除/撤权后的可用性。

与现有项根因不同：R54发生在QuickChat内部PNG拖拽接收前；R58为当前managed-worktree图片执行root；R65为EACCES目录列举；R39为archive/busy导航；R09/R17/R20/R34为实时上传准入/期限；R21为Hub初次运行输出anchor被裁空。本例数据已被合法旧producer持久化，journal从未发布，显示偏差发生在已支持legacy reader/projection。旧第四/十二/十四轮文件历史控制没有覆盖该unavailable→session.history图片显示路径。

## 本阶段结算

本审计新增执行 **0**，没有本审通过/失败断言可计入通用套件，没有原生收据、真实authority、真实WS或完整App结论。保留窄P3候选，需父审授权后的 actual hook→Main→disk reader→Workbench fixture成功、独立复跑、cleanup/guard/failure账本齐全后再决定正式收录。任何harness/导入/守卫失败应先留原始记录，不记产品缺陷。

### 作者首次授权失败：尚未到达候选

在本稿落盘后，只读核了作者 `first-authorized.log`、`first-authorized.observed.json`、`first-authorized.source-manifest.json` 和冻结 `legacy-native-history.first-authorized.ts.txt`。作者 latest 首次执行是 **0pass/1fail/1file/1test，无Completed**；日志无expect计数，不臆造。首次source SHA仍338c90fd、guard仍6e1f5f。错误 `invalid PNG image structure: IDAT CRC mismatch` 出现在 stageImageBytes→实际 `image-byte-probe.ts:74`，phase=`failed:producer-preparation`，尚无 routed/reply event、没有hook/fallback观察。attempts=[]，cleanup四字段均true且errors=[]；这些仅是原始失败收据，不能合并为候选已复现。

CRC合法PNG可从已维护 `attachment-service.test.ts:28–32` / `mobile-chat-turn.test.ts:10–13` 获得。产品正确拒绝坏PNG不是本候选、也不是待修产品问题。该阶段首次失败与后续成功须分账，本独立审计不会替作者执行或混入统计。root另已报告首次Bun expect为0、private HOME实测removed，首次原日志未打印expect计数，来源应明确分开。

### 作者第二次授权成功：有限动态证据，独立复跑尚待

已只读核 `png-fixture-correction.json` 及原始第一/第二source：root只替换PNG byte常量为维护测试中的合法PNG并加来源注释，未改产品、guard、metadata、authority或control。最终作者source SHA=`dfe9749f86552d7529af7ea9d323d43ce95904ee82d5654201b17c3f62d221e3`，guard仍6e1f5f。最后读 `second-authorized.log`、`second-authorized.observed.json`、其source-manifest及冻结source，实际是latest **1file/1test/17expect，1pass/0fail/0skip，Completed**。不是首次失败变成功，更不能累加为2个通过测试。

收据确实显示真实hook依次发select/outputJournal、收到unavailable、自动发recovery.cancel/history并接收history.ok；旧user正文有model wrapper/说明、attachments缺失，实际Workbench SSR断言显示该正文。首次真实journal publication后的同条旧user在hook state中变为干净正文和 `historical-shot.png`/image/png/68bytes summary；现代control没有第二次Workbench SSR，不夸称两个完整UI都动态渲染。source静态证实真实DesktopApp把同一app.chat交给Workbench，真实session.list分支（handle-client-event:512–532）会列出普通top-level、现存cwd的旧native Session，并没有journal存在筛选；fixture动态只直接选择已知合法seed，不是完整侧栏/OS导航。

原始/staged/恢复后PNG均68bytes、SHA=`431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`，文件仍在，聊天显示不含base64；普通task和assistant answer控制通过。controlled authority调用6次、transport errors=[]、attempts=[]；recovery revoke/hook unmount/pending settled/owned files removed均true，cleanup errors=[]。这些来自内存transport与controlledstamp fixture，不推成实际Git authority、真实WS/设备、Engine/provider、原生Desktop、OS隔离或完整modulegraph验证。

读现有 `transcriptReplay.test.ts:76–102/104–121` 还可确认现代投影已有名称/大小/显示正文与无base64契约，并保留普通用户写的XML正文；修复应按真实persisted附件格式复用安全显示投影，不能无条件删除所有相似字符串。这些既有测试仅只读，未在此审计重新执行。

当前审计者仍0执行，作者成功为1/17且历史CRC失败独立保留。父审两冻结基线复跑、正式编号和整合审计尚未进入本稿，不提前改变83项或通用83/247。
