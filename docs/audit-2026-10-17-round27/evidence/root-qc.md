# Round27 Root QC 与目标审计

上一goal turn为 **progress**：Round26已提交并FF集成 `9b667863e8a8eb91db7b1f99eb9876169dcf19ec`，2项新静态问题（P2/P3）和原工作区保全有外部收据。本轮进一步完成正常producer/consumer静态审查、增加独立P3、保存首次failed runtime和静态候选，属于可核实进展。未把全仓目标缩为一个batch，也未标 complete/blocked/paused。

本轮冻结基线9b，分支 `codex/audit/compose-frontier-round27-20261017`，复用本chat附属owned worktree。Root已重读CODESHELL/AGENTS；initial fetch89843、end66817、latest16649均同handle得到exit0。origin/main仍02d5d9a，branch从origin/main建立后FF最新local main。最新观测main与frozen均9b；本轮选定源码无并行主线delta。最终若main或dirty变化需重新记录真实时点，不能拿旧snapshot强称保全。

**分类：1formal（AGGREGATOR-R27-01/P3 static）/1candidate（COMPOSE-R27-C1 SKIP）/1old-related（ROOT-R27-R1→HL-01）**。worktree路径formal由独立普通输入、正确事件cwd、丢身份字段、真实file click消费链静态确定；Root和另一个reviewer均核过。duplicatepath/key条件性后果不拆新发现，未观察点击/打开/Reactwarning或内容丢失。旧dock主session cwd和外部CLI自行迁移导致stale launchcwd不是同因果。empty external snapshot等未满足强合同的线索不凑第二项。

**唯一runtime：1attempt /0clean /1failed /0rerun**。首次raw2272B SHA3419b38917c264fa865bcca06aa7160da25216f1b056c713ceb57a42f6a33a48，先保存merged stdout/stderr和exit再读。Bun实际16pass54expect，另1fail1error、reported17跨2files；全部pass属于已有compose suite。Root自写focusedrelativeimport多退一层，3focused bodies/ownedmodel/consoleJSON均0进入；不得把authoredliteral当observed，不得把reported17当17pass。没有Completed。夹具2622B/SHA9f38f940423daf3877d3aa9bfd390af7949aac802ca29b68272a4a2cb8d464fe保持首次，未修复重跑或替代执行。整个该动态方向SKIP，compose只candidate，无formal升级。

其余4静态作者方向（compose、snapshot、aggregator、RootCore/Link）各自0产品/import/test/fixtures/React/browser/native/network/Git执行。Root的audit branch/fetch/Git blob/hash/metadata脚本不是业务Git运行。没有真实模型、账号、用户数据或生产CLI/FS/permission/security/custody实验。没有产品修改、build/fullsuite/typecheck，也不称产品checks全绿。

首个成功assembler给出 **62unique source/meta pins、93 source checks、20 prep hash-only checks、55 author artifacts、4 verbatim prep copies**。93 =Root9 +Rootfrontier11 +compose7 +snapshot10 +aggregator29 +Rootformalreview12 +independentformalreview15；包含重复文件与指令/旧合同，不能换算成93新完整产品文件。62去重库存另含package/lock/config metadata；full SHA不是语义全读。20prep首次inventory只作hash复核，4copy保留原parent5e/时间/read-scope，不冒称原作者Git验证或20新全文阅读。所有after-read首次SHA/nullinitial标记保留；Root逐项绑定frozenGitblob不会回填作者没有执行的动作。

作者材料55 =Rootruntime9 +Rootfrontier8 +compose13 +snapshot10 +aggregator15；再加4copy为 **59 artifact checks**。第一版index87项是刷新窗口的时点，随后RootQC/聚合review等会加入；最终索引数应以最后assembler/外部stage receipt为准。首份source/raw/authorreceipts不因finalindex刷新而覆盖。原始failedraw必须force-add逐字，不能为了whitespace改日志。

历史全语料2596（1250MD/1346JSON，468104string/676635scalar，0parseerror），MD与递归JSON value scalars含档案排除current27。各作者模式及occurrence/命中单位/cap保持原口径；不把context截断误说成总命中，也不拿正则证明语义穷尽。精确目录component archive/_archive=169，路径substring archive=174，差5条为archived-open-observed、archive-first两文件和含archive的两文档名；同一完整库存，无漏扫。Root和两reviewer分别复核口径。

运行边界、Rootfrontier和formal三个独立review均支持现有边界。aggregate reviewer仅做metadata/源码材料检查，不重跑verifier或产品；Root最终verifier检查index集合/bytes、localMDlinks/ranges、author/copyreceipts、frozen/current/main。metadata locator错误分别保存人工diagnostic摘录，不假冒产品raw。作者receipt临时更名的并发窗口导致Root一次FileNotFound，已记录首响应并在最终冻结路径重核15材料，没有重复append12pinmanifest或重跑产品。

本轮initial primary为main9b，tracked deletion及4个untracked逐byte/hash记录；当前premerge snapshot与initial一致。Round26曾发生的untracked JSON漂移不是本轮“恢复”或回滚；当前仅保留真实最新状态。最终只暂存owned27prefix，精确cachedpath/blob比对、nonlog/fullwhitespace、commit/primaryblob检查，primary只在incomingpaths与dirty disjoint并可证明保全时FF。外部收据保存最终commit/dirty/sourcepin字节和ownedclean；不push。由于整体audit继续，ownedworktree仍active而保留。

全仓目标仍未完成，旧失败方向保持SKIP，其余内容继续审查。当前结论只覆盖实际full/selected范围，不能据此宣称所有源码、运行平台或剩余模块无bug。
