# prep81 /cost 远程空singleton假设：独立反证

**撤回原假设，0 formal / 0 candidate / 0 related。** 当前实际CLI交互路径没有提供这个远程/Engine分进程触发条件；它创建本地in-process transport，并把/cost使用的同一个全局costTracker交给EngineRuntime绑定usageLedger。不能用公共client参数、任意SDK或手造providedClient建立正常远程TUI路径。本结论不宣称/cost所有聚合、参数或格式行为正确。

本次不是盲审：Root给了待反证假设，我自行读实际入口、mode/字段和绑定链；未读Root80或其它可变作者包。旧full不被用来证明无bug，重读是这一个明确假设的selected核验，不称首次/未读frontier。CODESHELL在71完整读过当前217行，unchanged hash继续携带，指令本次只重复pin；dc2b3d4c7b3650e36f27deda6f20c87712a8e684仅Root最后提供上下文，own Git0。

**实际入口和绑定反证：**

- main120–124的显式repl与177–187无task默认模式都调用replCommand；interactive options79–82为resume/prefill。64的base-url明确是LLM API base URL，不是远程Engine/UI endpoint；ReplOptions42–54也没有独立server/client/remote transport选择。
- repl22导入Core costTracker，215把它原样赋给sessionCostTracker，223交给new EngineRuntime。runtime54–60赋给this.costTracker并调用bindLedger(this.usageLedger)。CostTracker90–97的bindLedger/getUsageSummary投影正是该ledger；371导出全局singleton。因此“本地空且未绑定singleton”不符合所查正常初始化路径。
- repl258创建serverTransport/clientTransport pair，268–281分别交给同一生产入口中的AgentServer和new AgentClient；323–331将此client传startInkRepl。ui/index70–71直接交给App，App157–167解构同一client，355–361再用useSessionUsage(client,sessionId,sidRef)和formatter。这里的逻辑client/server分层不等于实际远程模式。
- /cost的真实实现core-commands6同样从Core导入costTracker；94–96优先getUsageSummary→formatSummary，之后才有98–100的“No API requests yet.” fallback。正常local绑定分支先读同一账本，缺少原假设所需的分进程空tracker producer。没有运行命令或声称观察到任一实际输出。

生产调用搜索6227a7在packages+scripts中定位startInkRepl：repl是实际生产调用，ui/index是定义，ui/index.test只文件名未读；Core chat-session-manager594只是cleanup注释，不是另一入口。此界限不排除库用户在repo外另造transport，但这些任意SDK场景不构成本候选真实支持CLI路径；未据此新造远程配置或fixture。

[Assessment](assessment.json)明确撤回这一单项假设。COST-R9-01的[canonical旧finding](old-cause-decision.json)是未绑定standalone CostTracker丢完整model ID并误估价；它的dated限制本来就区分EngineRuntime已绑定账本。没有借旧日志或testpass再次“验证”，不重报旧因，也不把不同聚合session、/cost stats/detail、异常/计价或过时异步结果的未审问题包装成新candidate。

[Fresh history](history.json)和[本次metadata方法](history-method.py)纳冻48、排numeric49+（含本未来81），检索全docs/bugs MD文本及递归JSON value scalars，keys不作为scalar搜索。4492=1442MD+3050JSON、1953735strings/2921270scalars、169exact archive/_archive、0parse。main path476/SHA102/filename694、commands path198/filename207、App path2350/SHA528/filename5060、broad cause1776均cap100只保留100；commandsSHA9全保留。607个精确path/SHA对象是机器gate记录，不是语义读尽；实际只输出[旧scope首16行](old-scope-selected.json)和COST-R9-01原finding，不能把cap或派生claims当作完整查重/新增阅读。

[source manifest](source-manifest.json)：7selected产品文件、220语义行，0full/0测试；另1个Core文件仅594注释导航，所有文件display/nav union合计570行。原[初始pins](initial-pins.json)、[entry pins](entry-initial-pins.json)、[binding pins](binding-initial-pins.json)均在对应正文/行导航前；[片段](source-excerpts.json)在实际显示之后保存，未倒称读前文本捕获。测试只文件名导航，无声明阅读或执行。

真实配置/会话/账号未读取；权限/identity/transport连接机制、ledger锁/persist/价格、native和模型实现停边界。设置读取、credentials/API-key字段、goal磁盘callbacks、renderer/timer、stdin/bootstrap及cleanup邻接仅display/nav，不执行或认证。产品/helper/import/client.query/连接/fixture/test/React/provider/native/网络/Git运行和产品写入全0，见[validation](validation.json)。所有命令exit0，无首错或截断需隐藏。

[Ending](ending-checks.json)：10个源/指令pins及1份旧finding metadata全同，4492历史集合无增删/字节漂移。原时点不倒写，不认证未来HEAD。冻结见[receipt](reviewer-receipt.json)。
