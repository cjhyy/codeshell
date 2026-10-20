# root / operations-memory 独立只读复核

复核基线 `ab8b03f86ad38835939d4125b56bf4513cae7f15`。本次只读 `root.md` 的 R2-01～03、`operations-memory.md`、7 份相关证据脚本与原始日志、3 份基线日志尾部、相关生产源码/已有契约；没有重跑测试、失败支架或启动进程，没有改其他人的报告。R2-04/05 在本次分派时尚待补充，不在以下结论内。

## 结论

保留 R2-01/P2、R2-02/P2、R2-03/P3，以及 OM1/P2、OM3/P3、OM4/P3、OM5/P2。OM2、同名 TTL/搬移候选和 cold queued 恢复边界保持不计正式发现。没有发现需撤销的问题；初读时有一处源码位置需更正；复核收尾确认主审已更正。两处证据/措辞约束需在汇总时保留。

| 条目 | 根因、预期与分级复核 | 脚本/日志收据 |
| --- | --- | --- |
| R2-01 / P2 | `session-discovery.ts:15–16` 有损编码自然碰撞，`:244–249` 返回调用者 cwd，违反 `DiscoveredSession.cwd` 在 `:22–25` 明确要求真实外部 CLI cwd 的契约。`related-session-discovery.ts:94` / Main `index.ts:5864` 接线成立。历史读取跨项目混淆足以 P2；报告正确未延伸到真实 Claude/takeover/写文件。 | `root-session-discovery.test.ts` 真 reader、自有 JSONL、碰撞与不碰撞对照；日志 2 pass / 8 expect / Completed，报告一致。 |
| R2-02 / P2 | async 列表 `codex-session-discovery.ts:46–47` 选最新 mtime，history 定位 `codex-session-history.ts:209` 返回首匹配。发现源码 `codex-session-discovery.ts:244–248` 明确支持 resumed thread 新 rollout 同 id 并要求 newest，预期有依据。实际漏新历史，P2 合理；tail 仅静态、无真实 Codex 的边界已说明。 | `root-rollout-selection.test.ts` 先观察实际枚举再把该项设旧，不假定字母排序；2 pass / 6 expect / Completed，报告一致。 |
| R2-03 / P3 | 工具原文作为 literal tool_result 放入 fence，内层三反引号改变 Markdown AST。正文仍存在，仅导出阅读结构破坏，P3 恰当。初读报告129–132漏模板；主审现已更正为130–134，最终索引建议关键134。 | `root-export-fence.test.ts` 真实 render + marked lexer，正文标题成为 heading，普通结果正常对照；2 pass / 5 expect / Completed。 |
| OM1 / P2 | `global-dream-promotion.ts:99–114` 无视 ADD 决定，以名称找既有 auto/dream id 并覆盖正文。上游 `memory-orchestrator.ts:613–615` 明确要求比较正文、保留方向/否定/数值/作用域差异、缺证据选 ADD；`:661–663` 注释亦只允许 exact repeat 静默抑制。因此不是单凭测试作者偏好推断 ADD 语义。另一条 auto/dream 持久事实丢失，P2 合理；manual/真实模型影响未泛化。 | `ops-memory-promotion-round2.test.ts` 首项实际 orchestrator + manager + gate；日志明确两次 fake JSON响应、remaining只剩新read正文、old charge正文消失。整组2 pass / 13 expect / Completed。 |
| OM3 / P3 | `session-memory.ts:98–101` most-recent-first，`:146–148` 接受 Date.parse 有限的时区偏移字符串；`session-memory-sort.ts:12` 字符串比较确实可能倒序。内建 orchestrator 统一UTC不触发，SDK/import条件已收窄，P3适当。 | `ops-memory-data-round1.log` **1 pass / 3 fail / exit1 / 无Completed**；第一个case有明确 expected/actual，源码也直接支持。可以保留该窄观察，但汇总不得标该shard完成、不得计为通过整组；其他三个失败case未确认且不重试，现报告准确。 |
| OM4 / P3 | `agent-progress.ts:53` 复制“最近工具”的 startedAt，两个不同id工具交错后名称与开始时间来自不同工具。`agent-notifications.ts:43–47` startedAt/finishedAt 是同一个 lastTool 的元数据，缺信息可省略。`agent.ts:386–398` 实际消费 reducer。仅进度元数据错误，当前UI时长未证实，P3边界准确。 | `ops-progress-recovery-round3.test.ts` 首项纯reducer三帧，实际Read completed startedAt=20而Read原start=10。2 pass / 7 expect / Completed包含另一正常queued边界，不是两个bug。 |
| OM5 / P2 | `memory.ts:143–144` project-scoped store契约与 `:189–191` 有损路径key冲突明确；自然嵌套根/连字符根共享持久目录，并使“Project memories(this repo)”出现别项目事实。P2合理，无需把它包装成安全越权或声称执行错误文件操作。 | `ops-memory-project-key-round4.test.ts` 真目录/manager/cold reload/index，日志先B看A再B看两项，与6断言一致；1 pass / 6 expect / Completed。 |

## 需修正 / 汇总时必须保留

1. **R2-03 定位已更正。** 初读报告 `export-md.ts:129–132` 未包含出错 fence模板；主审收到清单后，复核末次只读确认现报告为 `:130–134`。准确模板在 `:134`，最终 findings 的 line=134。
2. **OM3 完成状态不能升级。** 整组失败且没有完整JUnit完成门禁；只有第一测试通过的局部观察。现 operations-memory.md 已正确披露。汇总/validation/evidence index须继续标 partial observation + failed shard，而不是4测试通过或clean focused dynamic receipt。不要求重跑。
3. **OM1 预期建议补明确源码契约。** 推荐附 `memory-orchestrator.ts:613–615,661–663` 作为 ADD不能替换另一事实的依据；这能排除“name是canonical key，gate有意refresh”的最强反论据。现结论本身成立。
4. 可选措辞：OM1“同名但不同类别正文”建议写“同名但不同请求类别的正文”，因为fixture两条 `type` 都为 reference；不要让读者误解成MemoryEntry.type不同。

## 不计问题的决定合理

- OM2 的 stale pending 最初待审快照可能是有意行为。已有纯本地动态观察成立，但没有必须同步最新候选契约，不计P3正确。
- 三个同名TTL/搬移脚本中，TTL在枚举前置断言失败；promotion/approve实际选择枚举首项，正确删除选中对象。原日志保留且未补支架重跑，不能据此发布同名误删正式发现。
- cold queued恢复：RunQueue Phase1无持久化、recover只扫running的明确范围与观察一致；SDK start正常，不能从CLI缺start推断已实现承诺被违反。

## 旧记录查重与收据范围

只读 `docs/audit-2026-10-16/findings.json` 的25项，未有上述生产文件/根因同项：旧 D01/D02 是 @file search截断/编码、D03是Chrome UTF8 decoder；C04是相对Write/Edit备份；其余Coding/TUI是ApplyPatch/Git/commit/undo/run模型/权限/JSON输出等。R2-01与OM5虽然都为有损路径编码，但分别是外部CLI bucket归属和Core memory持久根，独立实现、独立修复，不合并。OM5亦不同于UI-02大小写敏感Host的Web归属。

基线收据额外核对：root parser为72 pass /186 expect/7 files；operations baseline为11 pass /26 filtered out/89 expect，runner总37 tests/26 skipped；本地run state为15 pass/40 expect。三者与原报告一致。OM3所在失败shard始终不包含在这些clean基线数中。

本质量复核新增动态执行0、修改产品0、修改被审报告0。结论来自既有首跑原始日志与源码核对，不能当作第二次独立动态复现。

## 补充复核 R2-04～08

只读新增5份脚本/原始日志（04、05、06+07、08，其中TUI共享一组）、相关实现；没有重跑。06～08此时主报告尚待写，以下按已保存证据评估。

| 条目 | 复核决定与证据边界 |
| --- | --- |
| R2-04 | **确认 parser 缺陷，建议从 P2 降 P3。** `session-history.ts:87,113` 对合法JSON null解引用确实抛错，malformed JSON有明确skip处理，故隔离预期有依据；`readRecentHistory:181` 不catch也成立。但这是单一已损坏/非schema transcript，未有正常Claude writer写null证据，影响限定该会话而非所有正常历史。和10-16 SWC-05导致整个磁盘会话目录查询失败的广泛影响不同。保留“本地损坏边界”条件，勿宣传正常writer可触发。2 pass /4 expect /Completed与报告一致。 |
| R2-05 | 保留P3。`stripMarkdown.ts:6–8` 明确fenced code正文verbatim；`:14` 先移围栏，`:39–40` 后改暴露代码，Python正文实际变成name/main/abc。2 pass /6 expect /Completed、普通prose及简单代码对照充分；只影响回复整段“纯文本复制”，不是代码块独立复制、原消息丢失。 |
| R2-06 | 建议P3。`MessageContent.tsx:158–175` 在原始文本扫描表格而不跟踪fence，`:316` hybrid先提取表格，故代码示例被拆成真正表格。真实TUI fixture输出保留尾部三反引号却丢失表格源码分隔符；简单含pipe代码与普通表格对照正常。不是支架自行渲染替代实现。 |
| R2-07 | 建议P3。`MessageContent.tsx:177–181` 用split("\u007c")错误切escaped pipe，header两列使第三项expected-tail不被展示。真实TUI输出为left反斜杠/right，原last-column文本消失；属于内容误列/缺列，原消息仍在。规范明确escaped pipe属于cell内容，因此不是要求支持未承诺扩展。 |
| R2-08 | 建议P3。`external-agent-changes.ts:121` 只识别Update/Add/Delete File，不含Move to；正常rename返回已移除旧路径却遗漏新路径，违背该模块`:16–20` “set of changed files / N files edited”归属目标。3 pass /6 expect /Completed，包括普通三种header对照。第三项JSON arguments异常确有观察，但是否实际Codex writer用JSON包装apply_patch尚待证明，应该继续标候选，不能扩为第二正式bug。未执行真实外部CLI、patch或UI review。 |

R2-06与07共享 `root-tui-tables.log`，整组只有3 pass /10 expect /Completed；不能把每项分别计3个测试。R2-08日志含2项rename/正常对照与1项JSON候选，总3个测试，只1个正式发现。

GFM契约已核对官方[4.5 Fenced code blocks](https://github.github.com/gfm/#fenced-code-blocks) 与[4.10 Tables](https://github.github.com/gfm/#tables-extension-)：fence正文按literal文本处理；表格cell中的反斜杠转义pipe应保留在cell内容中。此处为规范查证，无执行网站代码；未用第三方说明替代官方规范。两项只引用/转述这两条短规则。

新增项与 `docs/audit-2026-10-16/findings.json` 的25条无同根因已确认项；R2-04与SWC-05同属null校验家族，但生产组件、隔离范围和修复点独立，不重复计同一实现缺陷。补充复核新增动态执行仍为0。

## 最终补充：Review R2-09～11

只读 `root-unified-diff.test.ts` /原始 `root-unified-diff.log`、`parseUnifiedDiff.ts`、`ReviewService`生产分派、`desktop-services.gitRun`与各diff参数、`UnifiedDiffViewer`的parse/filter/title/open/comment接线；未执行测试或Git命令。保留 R2-09/P2、R2-10/P3、R2-11/P2。

- **R2-09合法正文错认header可达。** 原始日志是自有Git实际生成的补丁：hunk后合法 `--- before` / `+++ after` 正文来自文本 `-- before` → `++ after`。parser `:62–72` 不检查curHunk就改路径并continue，`:105–118`还排除三个加减号开头内容；因此actual AST路径before/after、无add/del、context从1而非2开始都与代码相符。普通ASCII修改对照正确。这是普通文本改动的审查内容遗漏，不需要手工伪造Git输出，P2合理。UI错误打开/评论路径仅静态接线，现报告没有冒充点击复现。
- **R2-10纯rename身份缺失成立，P3合适。** `:48–57` 声称信任diff --git文件身份却不提取路径，`:74–76`只设renamed，无rename to解析。实际Git纯rename无---/+++，因此两路径null。header未知名称、onlyPath不能命中为直接AST后果；原文件仍在、无正文改变，不提高P2。fixture显式 `--find-renames` 确保格式，生产 `git diff` 没有禁用rename，[Git diff.renames](https://git-scm.com/docs/git-config#Documentation/git-config.txt-diffrenames) 默认true，标准rename输出可达；不要声称所有用户配置都启用rename。
- **R2-11不存在生产统一禁用quotePath的反证。** `ReviewService:72–75`分派到getGitDiffForReview/getGitRangeDiff/getGitCommitDiff；`desktop-services.ts:78–85`原样execFile("git",args)，未注入-c/config env；`:598–605`、range/commit函数只给diff/show、no-color/unified/root等参数，没有quotePath false。生产packages检索未找到统一quotePath设置。`UnifiedDiffViewer:82`直接parse；`:181–182`按真实onlyPath比较，`:261`title、`:346`打开、`:405–411`评论定位消费错误路径，无下游解码。中文文件默认配置下review定位不可用，P2与现有10-16 D01严重程度一致。
- **R2-11fixture与默认配置须分清。** 脚本明确 `-c core.quotePath=true` 构造escaped路径、再 `false`对照，并非依靠operator全局Git配置。官方[core.quotePath](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath)确认默认true；false仅不把高字节作为unusual，双引号/反斜杠/控制字符仍需escape。官方[patch格式](https://git-scm.com/docs/diff-format#_generating_patch_text_with_p)也明确路径引用规则及rename from/to。报告“默认quotePath=true”语义正确，不应扩大为所有配置、所有特殊路径均已动态测过。

三项共享唯一完整shard：4 pass /13 expect /0 fail/skip /Completed，第四项ASCII正常对照。不能各累计4个测试。日志原样保存了raw Git diff与生产AST，足以支持三个不同parser缺口；没有新质量复现。

查重：10-16的A01是执行rename丢mode、D01是@文件搜索的ls-files路径解码；当前file-search已用NUL输出，该修复不触达Review parser。10-12 Review R59是首提交无父range错误，不是hunk header、纯rename或quoted path解析。对10-12主Markdown与remaining findings的parseUnifiedDiff/quotePath/rename关键词有限查重未见同项。R2-08只影响外部CLI changedFiles收集，与纯rename Review AST为独立实现/修复，不重复同一缺陷。

额外定位修正清单：R2-08现主报告写external-agent-changes.ts:123–131，漏了真正的header regex `:121`；建议主位置改 `:117–125` 或line=121。R2-09报告的UnifiedDiffViewer打开动作行号354应为当前源码346（路径title在261）。R2-07说明实际字符串建议统一“left+一个反斜杠”，日志JSON中双反斜杠为转义表示，不是用户画面两个反斜杠；不影响内容丢列结论。OM1已补明确契约并澄清两条都是reference，R2-04已降P3，本复核末次只读确认这些修正落盘。

最终Review补充阶段新增测试0、Git执行0、修改被审报告0；此前质量材料路径核对曾只读git status，未运行任何Git fixture或Git修改；仅本复核文档追加。所有对真实Git/renderer的动态断言均来自主审已保存首跑证据。
