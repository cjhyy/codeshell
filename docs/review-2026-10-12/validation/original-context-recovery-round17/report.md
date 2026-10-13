# 第十七轮：上下文打包失败、取消与迟到回包正常控制

正式新增 **0**。便携脚本已在84740与a66f两个冻结产品快照分别guarded通过：**1文件4测试40个Bun expect、0fail/skip、Completed**。没有产品改动、build/clean、真实模型/CLI/账户或外部网络。模型边界使用测试自行注册的owned LLMClientBase实现，内部usage记录不表示真实付费请求。

## 实际运行与边界

实际 MessageStream → window.codeshell本地桥 → 实际AgentServer → ChatSessionManager/ChatSession exclusive → 实际Engine selectContextPackage/summarizeContextPackage/createSummaryFork → 实际SessionManager/Transcript/磁盘原子发布。LLMClientBase/client-factory使用实际类/注册接口，唯一provider为owned-review-context-round17；createMessage只在内存中返回固定文本、拒绝或有界等待signal，不调用真实提供方、HTTP模型或外部账号。持久source含user/assistant/turn_boundary，目标落盘后读取真实事件和provenance。

React/MessageStream使用MiniDOM，window.codeshell transport直接分派实际Core请求；onContextPackageCreated仅记录result/shouldActivate，没有运行完整App注册、renderer persistence、Main/preload/IPC。被切换到的第二个会话也有真实Core state，没有完整点击Sidebar导航。显示消息是受控fixture，不能称native输入或完整App端到端通过。

源码接线：[MessageStream.tsx:323](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/MessageStream.tsx:323)捕获source及selection generation，335调用fork，346传shouldActivate predicate；错误只对current generation呈现，[683](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/MessageStream.tsx:683)显示错误，691–694在packaging时禁用merge。App [2018](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2018)注册target到原project，读取target失败时保留可达target并使用空hydration，最后依据shouldActivate选择；此App分支仅源码核对，未冒充动态执行。

## 四项动态结果

1. **摘要失败保留选择，重试成功，无半成品。** 实际UI选择完整turn，owned provider真实抛错，经Core error envelope回桥并显示；磁盘只有原source，merge可点，无created callback。改owned provider为成功后点同一按钮，发送相同source/range并创建target。实际目标仅session_meta/context_transfer，summary/sourceRange正确，原source两个message仍在。未验证任意OS崩溃/跨设备事务。
2. **非法range/既有target在摘要前拒绝。** 向实际Core提交未知fromEventId，或将target指向已存在source，均error且owned client调用为0；非法target未落盘、source消息保持。SessionManager [2119](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:2119)验证range；Core在进入摘要前检查目标存在性，不是fakeEngine制造的拒绝。
3. **服务级cancel abort exclusive摘要，无目标，可再试。** 真实AgentServer summary进入owned provider await、实际ChatSession busy；同source agent/cancel通过真实Core控制abort signal，provider拒绝，fork错误且target不存在，exclusive释放busy。之后新summary成功。这里只动态调用Core agent/cancel，**未验证Desktop Stop按钮在摘要期是否显示或发这条命令**。ChatSession [231](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session.ts:231)与AgentServer [1826](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:1826)实际运行。
4. **旧成功结果不抢焦点。** actual UI摘要pending时切engineSessionId到另一真实持久会话；释放owned provider后Core仍正常发布target，callback收到result但shouldActivate=false，旧选择不再出现。target可由SessionManager读取；其在完整App Sidebar可达的注册仅由上述源码衔接，未动态断言。

Core [server.ts:1815](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:1815)在摘要成功后才创建fork；SessionManager [2144](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:2144)创建summary-only事件，[2287](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:2287)原子发布。既有server.fork.test.ts另有摘要期间新run排队及busy/queued拒绝，本轮仅只读，不重复计执行。target只含transfer而不复制原始选中正文是正常设计。cancel的实际入口为[server.ts:2433](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2433)，经server-run-controls到ChatSession.cancel:277。

## 排除与去重

没有把同tick人工直接连调两次onClick当重复打包缺陷。实际merge是disabled button，未证明像R35存在仍可绕过的未禁用input Enter入口。仅观察createContextPackage内部无同步ref不足以确认普通UI可达竞争；实际ChatSession.runExclusive在任何await之前同步设置exclusiveOperation，重复协议调用也不会同时摘要。

旧operation仍可完成发布，generation控制当前反馈和激活，并非隐含取消。与R55缺renderer索引的迟到打开抢导航不同，这里shouldActivate正确抑制。失败模型调用不发布target，与R03/R41已提交后的不确定回执去重属于不同边界；这些正常控制不推翻旧发现。未验证真实提供方超时、Main owner门禁、OS断电或任意文件系统拒写。

## 隔离、清理、执行

[便携脚本](reproductions/context-recovery-round17/context-recovery.test.tsx)、[初始基线最终日志](reproductions/context-recovery-round17/context-recovery.test.tsx.log)；latest最终日志随metadata另存。入口要求guarded HOME，在Core/Host导入前安装exact dummy loopback HTTP/fetch guard并deny directnet/tls，未连接该origin。所有source/target/usage在owned temp和隔离HOME，provider仅内存，没有模型子进程。guard不是OS sandbox。

afterEach先unmount，释放owned wait，await AgentServer.close/Engine.dispose，删除container、provider控制记录和owned temp；每用例确认unexpected direct network=0。provider注册仅当前Bun进程。补实第二个持久source后，两快照最终4/40分别重跑；此前通过日志另存original archive，不重复累计。没有测试harness失败；归档时曾误用log文件名的FileNotFoundError只影响复制命令，已改正，不属于产品或测试失败。

    node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/context-recovery-round17/context-recovery.test.tsx

**Completed：新增正式0；新1文件4测试40个Bun断言，两基线分别通过。**
