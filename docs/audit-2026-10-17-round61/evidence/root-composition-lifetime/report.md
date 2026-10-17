# Root157：composition lifetime普通所有权链

有限 **0正式、0候选、0新关联**。原R11 root manifest两个对象只selected，hooks `/files/11`明确lifetime当前同SHA full（onceDispose实际由HookRegistry导入）；当前重读保留旧全文重叠，不称首次或新唯一覆盖。原composition报告说明activation/lifetime只读、旧9pass没有运行实际资源激活；本批不借旧通过数。[原gate](prior-canonical-gate.json)。

lifetime.dispose先冻结同一disposal promise，按子scope及逆序资源列表排空，每个同步/异步失败均收集后继续，最后detach并汇总错误。ownActivationResult对已关闭scope的late返回值直接release；createPrivateServices每module一项privateService（types字段80）以moduleId注册，失败/abort先rollback，所有pending settled后合并错误，late install走release，不把未安装值写回map。

实际Engine647–649创建engine child，818–840依次启动private services→activators并保存同moduleReady；moduleServiceHost848–860已给冻结普通对象，不从activationContext再次freeze推断改变可变caller。session863–884先登记scope和删除回调，再await服务，1796–1805在成功后创建run scope与合并service值。runtime ownEngine72–78返回的只是删除close callback的onceDispose，不是递归调用同一个engine.dispose；close141–158先await engines，再dispose host scope。Engine4004–4028先abort、初始化期间先unwind，随后await run/moduleReady并finally dispose同scope。这里只核实际调用顺序与数据/所有权表达，不认证任意async factory必定终止、真实并发或native资源释放。

当前未建立普通内建producer下的新注册/释放遗漏反例；没有用自持self-dispose、不正常module key或任意永不settle factory制造bug。权限、MCP、sandbox和hot-reload等相邻显示不纳入机制结论。[源清单](source-manifest.json)5产品397语义行/564显示行：2full静态叶+3selected；0测试声明或运行。

[共享batch](history-batch.json)纳冻60排61+、含archive：6244历史MD/JSON、4350476递归JSON value scalar、0parse错误。六目标93/177/132/25/78/65，cap100，service/project只前100；机器访问不是全史语义阅读。Root只亲读原R11指定对象/报告，不由无命中认证新颖。

产品/helper/import/fixture/test/真实Host/会话/clock/native/network与本包Git执行均0，旧失败实验仍跳过。一次metadata wrapper invalid-escape warning exit0只在工具转录，不伪造原stderr；runtime显示请求170由helper实际clamp至EOF159，原requested表与正确actual表均保留。见[诊断](diagnostics.json)、[结束](ending-checks.json)、[分类](classification.json)、[自排除收据](artifact-receipt.json)。本包现冻结。
