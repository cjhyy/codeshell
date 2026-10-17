# Round25 聚合独立静态复核

支持 **1 个 P2 `OUTPUT-R25-01` / 0 candidate / 0 related**。本 reviewer 只读文档、源码字节、JSON、同份 raw/exit 和收据；本次聚合复核没有产品/import/test/fixture/VM/AST/native/network 或 Git 操作，只新增本报告。没有重新运行作者 fixture、wrapper、assembler 或 verifier。

实际读取 README、RootQC、output-clean 报告、findings/candidates/related/addressed-sources、validation、source-manifest/worker-integrity、全部 assembler/verifier 源码、Root/作者/static source manifests、作者 artifact receipt、prep copy receipt、integration-plan、metadata notes、[同份 raw](output-first.raw.log)/[exit](output-first.exit.json)、focused fixture、first wrapper及[独立证据 review](review-output.md)。已有 [normal producer 静态审查](output-static-crosscheck.md) 的语义范围及其17项清单保持独立，本次没有重新扫描全历史，也没有把62个全文件 hash 检查称为62份全文语义审阅。

**2026-10-17 10:24:31 UTC 的8b聚合快照**独立核验通过：62 unique source/meta 当前 bytes/SHA 均与该版 frozen/current/main 记录一致；30来源检查确为 **Root6+作者7+static17**，另47 prep hash-only确为 **data11+Root12+Link24**，重叠路径不增加 unique数或阅读数。17 static pins 的冻结 Git blob 已在此前10:17静态审查独立核验；本次其余来源通过当前字节、作者/prep声明及聚合记录交叉比对，不宣称重新读取所有历史 Git blob。assembler 在源码中逐项检查 frozen blob，再分别构建 current/main 字段；这是静态程序审阅，不是 reviewer 执行结果。

42项材料检查 = **18 author artifacts+24 prep copies**，逐项 bytes/hash 匹配；另外24 copies与其 originalPath 文件逐字节相等。实际作者 receipt 为 output-artifact-receipt.json，自身及两个 foreign output-static 文件排除正确。prep原先其它来源的full/selected声明、旧失败和分时history计数保持出处，不由hash升级为本批全文阅读或运行。作者7pins所列6个product/contract范围合550行，指令另217行，和聚合计数无冲突。

首跑实际 raw **2477 bytes / SHA256 `3756561600256bdbd45f529d4a6b0d0936c1e6fb49710c36a79a08e6d02c80d0`** 与exit、作者/聚合validation完全相同，attempt1/exit0/Completed/0fail/0skip/0rerun。逐行核四条JSON的input/expected/observed与findings一致；只一个根因，不是四个新问题。测试数 **13=7 existing+6 focused**；断言数 **23=7 existing+4字符化×3+2控制×2**。passing字符化锁定当前错误，不表示已修复。fixture仅直接导入真实零runtime-import叶子及bun:test，新增样本都是短ASCII；原7项含有限ANSI控制，不扩大为新ANSI/OSC或Unicode结论。wrapper先拒绝覆盖raw/exit、合并stdout/stderr落盘、结束后保存exit/hash再打印状态，支持首保存/后展示的边界；没有运行该wrapper。

P2影响保持已建立的窄范围：一次读取已含完整CRLF行时，cleaner删掉可见正文；LF和裸CR最后帧控制正常。all/incremental及BashOutput传播、incremental推进raw cursor是静态消费者证据。通常剩下空白行，不能必然解释为(no new output)；raw ring/disk不被cleaner写回。没有真实manager/tool、后台命令、Windows、日志落盘或完整LLM流程验证，也没有产品修复。guard runner自己的隔离HOME/JUnit动作不等于产品磁盘日志复现。旧cap/分页、frontmatter/Skill首次失败、NDJSON、simplediff、ANSI及权限失败方向均未恢复或重复计数。

integration-plan的initialPrimary与primaryBefore在8b快照**完全相同**，包含HEAD/status/diff与四个untracked文件bytes/hash，externalMainCommits/Paths为空；这里只核保存快照，最终实际暂存/commit/FF与dirty保全仍归Root收据。10:24时77个已存在Markdown本地目标/行号检查无误，仅README待创建本报告的链接暂缺。首index63原集合无缺失，RootQC追加导致其hash待刷新，review-output是预期新增；本报告随后新增，Root将统一重建，未故意执行过期verify。

Root的多余newline替换Assertion记录与作者literal-LF rg exit2、prep元数据错误均保持为metadata首响应；前者未改文件，后者人工转录没有冒充先保存的原始产品raw。作者纠正receipt归属、排除foreign review的经过也明确保留，未改fixture/raw/exit或增加产品重跑。分类、源运行边界与材料归属未见未解决缺口。

主审随后通知main并行前进到 `d9d2c33ddd1b2edea28a719e4cd0a505a96c0b08`（1commit/28paths），正在保存frozen/current/main差异。本报告上面的62项相等结论**仅绑定10:24的8b快照**；不能外推到后续main。新增28路径不据此算已审、已运行或已修复，后续Root source-delta与最终索引复核另记时点。

**末态追加：10:26:33–10:27 UTC。** 已读更新的main-source-review、integration-plan、README/QC末段及assembler相关分支。62pins的最新current/main SHA与当前bytes逐项匹配，只有 `packages/desktop/src/main/index.ts` 不同于冻结；42artifact仍全匹配。该源当前299337B/SHA `105b2b49a28e0a7ef10980ac5feaa3a07ff81e7197f5acbefd95feb2498224c0`，冻结299077B/SHA `77c8f9dcbd0ecf7000fd0c923d28b078f5fc187aebbd1b28830af18960233c4f` 保留不变。10:26:33索引66项集合/bytes/hash全部匹配；随后新增patch与本追加、Root范围订正仍需最终统一重建，未运行过渡索引的verify。

已完整读 [实际index patch](main-index.patch)：572B/SHA `330e03e433c51035baa79b46e5b858c4c86e92a5a0693d61a2701020b7700ddc`，唯一hunk **`-6447,0 +6448,8`**，8新增/0删除，全部新增行与当前6448–6455逐字相同；另静态读当前4206–4213及6439–6467。完整零删除补丁只在后方追加Review preparePrompt handler，支持早先Link作者4206–4213选段未改；actual output-clean及其producer没有被这次delta触及。其它27路径只有库存边界，不称新Review功能审查或验收。更新快照只有HEAD由8b变d9d2，原dirty各字段相同；最终实际Git/dirty验证仍归Root。

metadata范围说明：Root最初文字为old6446，我据此手工比较当前6447–6454得到false；没有断言失败、产品执行或更改证据。读取实际patch hunk后按其明确new6448/count8定位，上述比较为true；已通知Root仅订正旧行界文字。此为静态导航范围订正，不是产品重跑或新缺陷。除此无未解决聚合阻断，支持最终重建索引后由Root完成集成。

已末次核实Root的readScope/QC改为after old6447/new6448–6455，patchArtifact保存实际hunk，root-metadata-notes保留sourceDeltaAnchorCorrection；source及raw hashes均未因文字订正改变。Review ready。

**暂存metadata追加复核：10:29:34 UTC。** 首finalizer在commit前因full/nonlog whitespace各exit2停止，诊断均仅为worktrees-before.txt:84末尾blank EOF；首响应和两份完整diagnostic已保留。独立读取 `/tmp/codeshell-audit-20261017-round25-stage-verification.first.json`，其15427B/SHA `76e297abec495aba471f724c69fcdab2e4312623b83555e2eb29b66de4bdc4d3` 与notes相同；原stage的68条文件记录均属本批路径。新 [worktrees-before.json](worktrees-before.json) 的stdout以UTF-8编码后为3754B/SHA `4cddd7b193896945f7855ee1bf333b8fc0ac2aa4de65824fd901bbbcb25e8489`，同时等于originalBytes/SHA及首stage旧txt记录，末尾双LF分隔原样保留。raw仍2477B/SHA `3756561600256bdbd45f529d4a6b0d0936c1e6fb49710c36a79a08e6d02c80d0`；fixture1981B/SHA `14907b0efd875782bd5ba516fc333ed1c0e9f4f0ee41df94d311a0cdf199454f`、exit609B/SHA `8900f2026968caa8f138f95dcc7a7deed4625ccce5ab49496b2c4f2b3268c3f7` 均与首stage逐项匹配。RootQC/notes如实将此记为库存封装/暂存metadata修订，不是产品失败、产品修复或重跑；本 reviewer未执行Git、verify、产品或测试，最终重建索引及Git保全仍由Root完成。
