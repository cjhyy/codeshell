# Round27 Files fixture 最终独立预审（0执行）

UTC2026-10-12 01:33:33 / SG09:33:33。最终preflight支持root对下列修正版决定首次maintained guarded执行；独立审计本身不代替root许可，且尚未运行任何产品/import/fixture/test/Git/模型/worker/CLI/Electron/浏览器/网络。**0执行，当前没有observed.json/test log/Completed收据；正式85项、85文件250测试不变。**

当前文件：`/tmp/codeshell-review-20261012-file-root-round27/file-root.test.ts` SHA256 `28f4202efc90bedbd67f39f60bd7e9370a3b8557872ae841edb856e3720a13d2`；PLAN `a1dd0c7b3b599fd19f23f957102f53b56053046584db911100a4758535803e2f`；guard `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`；static receipt `e2f00e3537968fbdf78754602131d293bdb56a12202e4ef3749b3882ccb5c61a`。

已独立完整读精确 [test delta](/tmp/codeshell-review-20261012-file-root-round27/file-root.test.ts.prepare-delta.diff) 与 [PLAN delta](/tmp/codeshell-review-20261012-file-root-round27/PLAN.md.prepare-delta.diff)，并用纯字符串切分比较 `test("summary fork after Make primary...` 至EOF：修前/修后 **test业务、断言和cleanup逐字节相同**；guard原字节相同。新增仅准备阶段两项adapter/mock地址修正及scope/mockTargets收据字段。

两处首稿建议已经关闭：

- git mock同factory注册bare、dist/src绝对及realpath地址，去重并保存mockTargets。解决已知复制至repo后的source地址漏覆盖风险；不把declaredtargets/Bun.resolveSync称实际modulecachegraph。
- adapter只接受owned root-a/root-b精确路径，再抛标准 `fatal: not a git repository (or any of the parent directories): .git`。actual Main helper的真实 `/not a git repository/i` 检测会降为undefined，未改安全门禁或直接手写authority。

准备前 [prepared-initial](/tmp/codeshell-review-20261012-file-root-round27/prepared-initial) 四文件原字节已经复核：source55d3f4ddd71c838b98b186988f7d40ee3a2ebfed1e50fb03d797abcf33054c68，PLANa1f9589971fb55066c4939c7e9d5131e53622259f00698fc3a0822e640f07208，guard6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d，staticreceipt0ff82a8658c9827b3899f07e1d3efcaa784e5aa8705696874e71837e49858cde。它们是 **unexecuted prepare阶段**，不是first-failure或test run，不可加入失败/成功计数。

修后static receipt的51路径逐一重新读两个冻结树，全部SHA匹配，48整文件相同（Main index与Core两个公共barrel不同）。观察文件仍未产生。首次真正run后必须验证实际API tuples、FS错误、gitAdapter命中、normalcontrols、原件和cleanup/runnerHOME；当前不能预填任何pass/expect/exit/Completed/attempts[]/HOMEremoved。

actual Core summarypublish、ProjectStore makePrimary、actualauthority/rendererhook/Files、实际preload和ASTMain callback→validator/store.list/realFS的分层，与下面首稿完整审查一致。setPrimary trust/Sidebar上游、完整App/OS/真实Git/模型/forkRPC、首send仍静态；blank不在动态断言中；内部writer后remount仅internal control。R65目录吞错表现不重复计项。

以下保留 [55d3首稿独立预审](/tmp/codeshell-review-20261012-file-root-fixture-preflight-round27.md) 的历史全文（SHA4172dee71323102ee4ca89f2c3b78d76ff29879ffbc738eaac5f580ec0c7bf2a），其中“两处launch前建议”等仅描述修前，不覆盖本节最终结论。

---

# Round27 Files fixture 独立预审（未执行版本）

审计 clock：UTC2026-10-12 01:31:40 / SG09:31:40。本稿仅标准库读取/哈希、阅读源码；产品 import/fixture/Bun/Node test/Git subprocess/模型/worker/CLI/Electron/浏览器/网络执行均0。正式仍85项、85文件250测试。不是批准运行的收据，是否执行由root审阅后决定。

## 冻结输入与结论

目录 [/tmp/codeshell-review-20261012-file-root-round27](/tmp/codeshell-review-20261012-file-root-round27)。本次实际读到：

| 文件 | SHA256 |
| --- | --- |
| file-root.test.ts | 55d3f4ddd71c838b98b186988f7d40ee3a2ebfed1e50fb03d797abcf33054c68 |
| PLAN.md | a1f9589971fb55066c4939c7e9d5131e53622259f00698fc3a0822e640f07208 |
| network-guard.ts | 6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d |
| static-prepared-receipt.json | 0ff82a8658c9827b3899f07e1d3efcaa784e5aa8705696874e71837e49858cde |

整体测试支架保留了需要验证的 Files production rootOptions/read/effect、actual Main authority 与 FS containment，最小候选路径/正常控制/原件保留/内部补绑定边界合理。**建议在第一次执行前修正两处支架保真和便携问题**：coding mock 要统一覆盖源码地址；普通非Git adapter 应走生产 not-a-Git catch，而不是返回超出原函数类型的 undefined。两项已经发root/作者，尚无作者修后版本或运行结果。本稿不将其记作产品缺陷。

## 两处 launch 前建议

1. `file-root.test.ts:99–105` 同一 gitFactory 目前只 mock bare `@cjhyy/code-shell-capability-coding/git` 和绝对 dist barrel，未覆盖 `packages/coding/src/index.git.ts` 的绝对 realpath。repo tsconfig.json:30 正好将该 bare specifier 映到源码。Round23 Recent 已有作者 /tmp 通过、root复制进repo后 bare/source/dist mock地址不一致导致子进程被guard正确拦下的原始失败账本。因此这是具体已知便携风险，不能从当前 Bun.resolveSync 的四项地址推断已覆盖实际 import graph。建议同 factory 对 bare+source realpath+dist realpath（以及明确resolved allowlist）一次注册，并记录目标；保存55d3原件后再修。只读 resolve API 回包仍不能称 cachegraph 证明。
2. 实际 `coding/src/git/worktree/query.ts:43–48` 的 findMainWorktreeRoot 返回 Promise<string>，非Git通过 execGit 错误抛出。Desktop `session-workspace-service.ts:266–272` 才把标准 not-a-Git 异常降为 undefined。首稿adapter直接 return undefined，虽然对这个调用者最终结果相同，却没验证该正常catch分支。建议 adapter 对 **A/B两个具体owned目录** allowlist 后抛 `fatal: not a git repository (or any of the parent directories): .git` 一类真实识别错误，再由原helper处理；其他路径必须throw。记录调用/结果是“受控正常非Git错误”，不能说真实Git探针运行。当前 startsWith ownedRoot 前缀是安全owned限制，但exact A/B更贴合计划声明。

## guard 与副作用边界

首行import guard，后面静态imports仅 Bun测试API/Node标准库。guard完整SHA与前轮一致：要求maintained completion-private HOME、CODE_SHELL_HOME/TEST_HOME同路径、realpath自洽且private mode0700；先装项目exact-origin guard，再显式deny dummy origin以及fetch/http(s)/net/tls/dgram/WebSocket/listener/child_process/worker_threads/Worker/Bunspawn。所有deny记 attempts，scope明确这是in-process而非OS万能sandbox。没有真实HTTP、listener、Chrome、账户、模型调用必要性。

file-root.test.ts:31在manifest/import之前注册afterAll(receipt)。manifest或productImport失败会写phase/failure；业务owned根要到test try内部才创建，之后finally处理。当前observed.json未存在，符合作者“准备未执行”状态。此静态未存在事实不是清理收据，也不是成功/失败测试收据。

Core公共barrel会包含Engine/provider定义；显式SessionManager来自core/dist/index.js，其业务为create/Transcript/selectContextPackage/createSummaryFork/saveState；未构造Engine或模型。ProjectStore/authority的bareCore来源可能经tsconfig/exports选src或dist，source/resolve记录不能夸成统一modulecache图；没有依赖跨图instanceof的证据。未导入Main application/index入口，只读该文件提取callback。

## actual 与替身分层

- registry/source：actual ProjectStore.createFromPath/addRoot/setPrimary，actual SessionCwdIndex与actual Core dist SessionManager。constructor resolveProjectRoot只允许owned A/B并返回原目录，真实registry写入及mounted identity不替换。source初始binding用实际writer，匹配正常Engine保存形态，但不声称跑过source的真实模型turn。
- summary：actual Transcript append user+assistant、actual selectContextPackage验证closed range，实际createSummaryFork原子发布两个target。已成功summary字符串是受控输出；完整TopBar/MessageStream/forkRPC/LLM/App registration仅静态接线。
- authority：真实service通过现有test setters使用同一actualmanager/store；真实registerProjectAuthorityIpc捕获workspace:authority；真实createProjectAuthorityApi经owned invoke传入sender.id。没有手填authority响应；目标真实持久化，不借ephemeral Host grant。unused transport/services throw，store.setPrimary直接调用，因此 **trust/Sidebar/setPrimary IPC没有动态执行**，PLAN已经明确。
- Files：actual PanelWorkspaceRootConsumer/usePanelWorkspaceRoot和FilesPanel；wrapper仅从实际authority workspace和实际renderer registry reconciliation传同形props。B.id/A.path只能由actualFiles产生，未在adapter里预造。完整PanelArea/App/OS没挂，不可声称完整App点击复现。
- Main：AST寻找唯一channel对应arrow，保存源block/行号/SHA/capturedDependencies，经TypeScript仅擦类型再构造function。fsRoot:readDir需依赖requireRendererProjectRoot/readDirectory；fsSession:readDir需assertDesktopSessionId/readSessionDirectoryForUi，与实际Main相符。validator options.projects来自await actualstore.list，而非手造root表；sessionFS导入同实际workspace service，因此test setters与validator看同一registry事实。Main默认singleton没有被错误当成已注入。
- presentation/DOM：五个@叶子别名都转发真实exports，不替换Files业务；miniDOM、localStorage空初值、matchMedia=false是显式浏览器支架。React/ReactDOM实际现有19.2.6包，静态realpath已读，不作runtime graph声明。selector通过actualReact onChange props调用而非OS事件。

## 断言、对照与易误读点

1. 同primary summary控制用实际无binding target→hook A/null→actualFiles正常读A，检验“无binding本身并非问题”。
2. 改primary后boundsource仍A，实际sessionAPI分别读A和B；这排除Makeprimary破坏旧Session/根不健康。
3. 候选实际hook A/null/currentprojectB，默认请求P/B/A，在真实FS containment失败，UI没A/B独有文件；selector是两个真实ID；选A可读，选B仍读不到B。
4. 直接真实preload/Main/FS读P/B/B可见B，区别目录健康与错误参数。
5. 用实际writer补P/A，再**remount**后可读A/B，这是内部binding控制。不是完整firstsend，更不是当前mountedbody在send后自动刷新已经验证。
6. 两个owned文件末尾byte内容与初值相同，attempts要求[]。这不是所有原Session历史/其他用户文件已全面验证。

源中没有普通blank动态断言，PLAN明确只组件合同静态控制、不冒称App materialize sid后的完整blank route。目录catch空树属于R65；本候选仅rootId/path映射，不再拆反馈问题。不扩大到文件永久丢失、模型cwd错误、所有roots均失败、越权读取成功。

等待API调用pending=0、React act/microtasks后再观察，避免只等手工Promise障碍制造race；读目录是自然FS异步。settle最多200轮×5ms且必须对应新callStart之后的实际API结果/错误；选择控件同理。不存在恢复重试会重复发送模型或真实浏览器动作。

## cleanup 与证据收据

业务test进入后即记录ownedPath和cleanup；finally尝试unmount、移除DOM container、等待pendingIPC/FS、重置两个workspace setters、只rm自己的privateownedroot，检查notexists与errors；cleanup异常会取消completed并fail。setter是现有简单赋值，当前源未见业务throw。runner privateHOME的删除必须另外从真实run结束路径检验，**未运行时不预填HOMEremoved**。

receipt包含phase/failure/scope/guardattempts/sourceManifest/resolveonly/ASTblocks/gitadapters/APIargs+results/errors/workspace+DOM/cleanup，既有first/second/root各次必须独立保存不覆盖。作者第一次如失败应停并保存精确source/log/observed，由root决定修正，不能将支架失败当产品失败或将未Completed阶段计通过。

独立标准库逐项重新核static-prepared-receipt中51路径：两树全存在且各SHA匹配；48整文件相同，另Main与Core两个公共barrel不同。此为静态字节来源检查，既不是51个实际loadedmodules也不是测试通过。两处建议修后需要更新static receipt/PLAN/fixture SHA并核原始55d3封存，再由root决定首次guarded执行。本独立审核执行数仍0。
