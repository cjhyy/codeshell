# 第二十四轮最终独立整合质量核验

核验时间：2026-10-12 08:32 SG（实际clock UTC00:32:23）。审计者 `/root/goal_sleep_review`。本审计新增产品/fixture/原生/模型/网络执行 **0**，仅只读源码、归档日志/JSON、哈希及文档；未改产品或主报告。

结论：支持正式 **R84/F24-1/P3**，主报告、专项、流程图、进度、双基线元数据及原始收据之间没有未解决的实质矛盾。本轮是旧 paired-native 图片历史的窄显示投影问题；不是图片原件、历史或任务丢失，也不是任意历史导入、已发布journal丢失或公开repair流程。

## 正式可达性和根因

旧producer可达性已独立反证。`c9b1d959` 的真实 `mobile-chat-turn` 请求不补displayText/injected，AgentServer缺省归一、ChatSession透传、run-session-open持久化同字段；run-image-input/input-attachments在prejournal与84740的Git blob相同。不是因为字段可选而人为省略干净正文。最终fixture用实际stage/input helpers/SessionManager/Transcript重建合法旧paired-native格式，没有Engine.run/provider执行。只限定该producer，其他提供clean displayText的入口不推广wrapper暴露。

真实Main authority允许有效、未删除/替换/撤权且root可用的旧native no-repo Session，并不要求journal存在；每页selection/auth/Session/stamp门禁保持。实际native orchestrator只对external runtime要求journal，因此never-published旧Session可进入受支持fallback。真实authority包含Git probe，本fixture动态用controlled stamp/auth/device/viewer，**不把源码可达性写成真实authority动态验收**。

已核生产hook→unavailable→legacy→session.history→真实Main dispatcher/reader/server builder→reducer→Workbench接线；`session.list`静态分支没有journal存在筛选，fixture实际直接选择known seed，没有完整侧栏/OS导航覆盖。最小行号 `mobile-history.ts:34`、`transcript-reader.ts:255`、`userMessageDisplay.ts:153`、`Workbench.tsx:622`准确。先前质量稿有更完整source-chain，保留为08:19起的历史反证阶段。

旧合成user_message只带原始text，不带安全attachment summary；正常投影入口只接受session_user_message/steer_injected，不能在下游补救。实际old Workbench SSR确认内部wrapper和模型提示作为转义正文显示。路径本身含文件名，专项明确不称完全没有图片线索。

## 正常控制、恢复和能力边界

第一次旧history读取前从未发布journal，fixture没有unlink/truncate/覆盖已发布journal或pin。之后首次真实journal publication和同一transcript cutover使actual hook投影为干净正文及历史图片summary/clientMessageId。现代控制没有第二次Workbench SSR，也不是用户公开repair入口，不建议为修复显示启动模型请求。

三次最终成功收据均保留普通task、assistant答复与原始图片。PNG输入/staged/恢复后都是68bytes，SHA256=`431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`。旧history不向聊天显示base64。30天sent retention、5分钟upload ticket、objectURL与显式Session删除分别属于不同生命周期；候选限有效Session和仍保留原件，不包含过期/已删除数据恢复或历史缩略图/下载承诺。

最低历史图片契约（mobile-remote-send-image.md:213–217）确实要求隐藏内部path block并至少显示附件提示，第一版下载API可后置。长程journal文档的旧peer/无共同cursor保守降级、任意历史import TODO不取消此已支持native history的最低显示契约。现有transcriptReplay测试还保留普通用户XML；建议复用识别真实消息格式的投影，不做全局字符串删除。与R54/R58/R65/R39、上传生命周期项及R21根因不同。

## 原始失败和最终执行分账

| 独立执行来源 | 原始结果 | 本次只读结论 |
| --- | --- | --- |
| 作者首次latest，338c90fd | 0pass/1fail，无Completed，未打印Bun expect总数 | 无效PNG被真实CRC校验正确拒绝；尚未到hook/fallback、第一条Bun expect前，非产品失败或候选反证 |
| 作者修正后latest，dfe9749f | 1file/1test/17expect，Completed，0fail/0skip | 原始second日志和观测一致 |
| root初始84740，dfe9749f | 1file/1test/17expect，Completed，exit0，0fail/0skip | 本审逐项核真实归档log/observed/cleanup |
| root最新a66f，dfe9749f | 1file/1test/17expect，Completed，exit0，0fail/0skip | 本审逐项核真实归档log/observed/cleanup |

first→second冻结source差异仅PNG常量与来源注释；产品、metadata、auth/authority替身、guard、正常control未改。最终source SHA=`dfe9749f86552d7529af7ea9d323d43ce95904ee82d5654201b17c3f62d221e3`，guard=`6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`，作者及两root拷贝吻合。prepared执行0、CRC失败、成功运行均分账，不能累加为三个新测试或51个suite断言。原作者稿“0expect”是源码阶段推断，canonical专项和JSON明确原日志没有打印计数；该校正保留了原始记录。

本审分别验证两root每份31项source manifest与其冻结checkout字节相符，5个resolve-only地址哈希相符，bad项均0。两基线manifest差异只有Core public src/index与dist/index，其他29项一致；不抹平不同冻结基线。显式SessionManager来自Core dist，其余source/barrel范围按源码审计；resolve-only不是实际module-cache或统一modulegraph探针。

两root原始observed为completed=true/phase=completed/failure=null、attempts=[]、controlled authority调用各6、transport errors=[]。revoke/hook unmount/pending settled/owned files removed均true、cleanup errors=[]。cleanup JSON所列HOME/runner root/owned路径均removed，审计再次只读确认两HOME不存在。作者post-run cleanup及first failure清理另有收据，未混入root成功统计。guard是进程内防护，不是OS sandbox；没有真实HTTP/WS/身份、完整Main/App、Electron、物理手机、worker、Engine.run/provider/付费模型验收。

## 整合一致性

已读README、R84专项、flow-coverage、latest-baseline、reproductions/README、progress、原作者报告/诊断、双基线log/observed/cleanup、round24-results及latest summary。两份通用results都为 **84files/248tests/0fail/0skip**；正式表84个ID唯一、P1=1/P2=52/P3=31。本轮通用增量1file/1test/17expect、native增量0；新快照专属3files8tests与既有native/helper单列，没有重复加入通用数。

本专项30个本地链接含14个源码行号已只读核有效；源码对应语义与触发/正常门禁一致。gzip原始prepared diff解压SHA与收据一致，没有把压缩/机械规范化算成fixture修改或新执行。两冻结产品`packages`/`scripts` tracked diff为空。

发现并由root纠正的文档元数据仅为progress预写08:35→实际08:30、Webhook→Web hook，已重读确认。历史反证稿和作者08:22候选阶段保留当时83/247、未编号及等待root结论；应标为历史并由本最终稿承接，当前权威结算为84=1/52/31、84/248。除此无实质scope、恢复、证据或计数矛盾；支持docs-only保存本轮检查点，11:00前持续review目标不在此提前complete。

主审归档补记：后续Git whitespace检查发现首次失败Bun诊断日志第7行空白context的尾空格。可读副本仅删除该空格，[原字节gzip](validation/original-legacy-history-round24/first-authorized.raw.log.gz)及[SHA收据](validation/original-legacy-history-round24/first-authorized-log-normalization.json)保留，root机械核验解压/可读SHA准确；fixture/guard/执行未变，无重跑。本审原始交付字节另存[原始最终稿](validation/original-legacy-history-round24/independent-final-quality.md)。
