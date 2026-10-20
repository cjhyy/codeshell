# Prep133 — Panel tool job实际生命周期

有限结论 **0 新 formal / 0 candidate / 0 new-related**，另精确排除旧R30终态持久化失败原因。此次追到真实Host工厂、executor与process close，未由所读正常start/cancel/resolve/reject/回收链建立新竞态；未运行任何工具、进程、helper或测试，也不认证完整权限、身份、存储或OS机制。[分类](classification.json)保存反证和旧因边界。

Root提供baseline `1ba606416f4fc94c081159bb3fd10e58cd8d87f0`，仅外部上下文，Git0。实际filename确认tool-jobs.ts963行 / 36053B / SHA `6588b4f61611b9cc09a88642b162e00de8c4e3b29f79a7d856cc73c112f622b2`；[最初pin](initial-pins.json)早于正文/行导航，旧AGENTS5/CODESHELL217实际阅读按同SHA沿用。后续 [storage/shared/test/runtime pins](support-initial-pins.json)、[executor pin](executor-initial-pin.json)、[process pin](process-initial-pin.json)也均在各文件正文/导航前。

自己的 [14个精确历史命中](targeted-history-hits.json)只是path/SHA原始文本定位与字节pin，不保证转义JSON穷尽或文件从未读过。旧canonical [R30原报告](canonical-old-cause.json)明确：最终storage.write拒绝时，commit430–434尚未更新map，run806–830的terminal outcome未发布，pump768–774清active/resolve done后吞异常，结果丢失且job仍running。原报告还明确修复存储后可cancel/retry、重启可interrupted；本次不倒写成不可恢复、不重复权限/disk实验，不新增问题或关联。

Root共享 [批量历史投影](shared-history-targets.json)，[原batch pin](shared-history-pin.json)绑定纳56排57+的5676份MD/JSON、4212456递归JSON value scalars、0parse错误。tool-jobs29、storage27命中全保存，各cap100。机器数量归Root，不算本读者重新全史扫描或人已读完全部值；实际canonical阅读为旧runtime-round3的1–15行与resource-quality-round8的31–41行。未从原记录建立整个当前模块same-SHA旧全文，也不把unknown/hash当未读保证。[gate decision](gate-decision.json)保留这些区别。

正常生命周期的实际源链：

- runtime757–838把正常tasks.start请求的已选entry、input、recovery/requestKey与preparation signal传给共享或本地service；925–983实际创建createPanelToolExecutor并交PanelToolJobService。shared-tool-jobs固定scope后转发start/cancel/retry。这里没有凭任意DTO或人为mockthrow制造入口，也未把接口shape当完整授权证明。
- start为preparation保留独立controller和结果promise；重复requestKey等待既有preparation或复用已提交job，异输入拒绝。提交queued的exclusive fence之后再检查取消，阻止持久化期间收到abort的job进入executor；finally解除监听/删preparing/settle。runnable按queued/暂停/并发选择，pump先commit running，再登记active，执行实际run。
- cancel在serial fence读取当前job；非terminal先持久化cancelling（无active则cancelled），再abort，并在fence外await active.done。run等待execute后进入同一serial fence，从最新记录clone，按stopping/abort、真实failure、正常result写interrupted/cancelled/failed/succeeded。pump的finally在run settle后才删active、resolve done并重新调度。retry另检查active、terminal/error/recovery，不把取消中任务提前重启。
- 实际executor549–609捕获Host waitForExit，再写入完整输入、结束stdin，等待exit、reconcile/progress和有效result；错误消息构造Error，非零exit或缺结果也有Error路径。650–662清timer/listener，未terminal则await stop，再释放owner/resources。没有以`Promise.reject(undefined)`等无真实producer的输入凑“误报成功”。
- 真实process-service854–882在child close回调先await running.termination，再finishExit并发布process.exit；909–916的waitForExit绑定running.exit或已关闭receipt。因此取消等待的依据不只是execute注释。stdin write/end的结算选段也已读，但未运行native、kill group或计时器，不证明所有OS/外部程序时序。
- shutdown先stopping并flush admissions，abort preparation/active，等待两类done后写interrupted、清listener、close storage与unregister。加载unfinished checkpoint会标interrupted，不自动重放。storage.write源码先完成write/sync/rename再返回，正常commit依赖其完成；这不抵消已知R30的写失败分支，也不是当前故障恢复运行证明。

[source manifest](source-manifest.json)列 **7 selected / 0 full，1326语义行 = 1265产品 + 61测试声明**。当前阅读覆盖真实机制而非仅DTO，但scope/package授权helper、materializer、credentials/cookies、artifact capture、spawn/kill-group与完整path/lock custody均保留边界。3个既有partial test声明只表达“取消等executor退出”“shutdown等待”“manual/nonretryable失败”意图；24个最后有界标题导航，0运行，不把测试mock当生产反例。

[摘录](source-excerpts.json)在实际显示后捕获，只保存完整可见body与后续未截断locator。前三个宽输出中有缺失导航/尾部，**1856显示行是已完整捕获union的下限**，不是全部生成输出的精确总量；语义范围与计数仅取完整可见块，准确独列，不从truncated中补读。display/nav/semantic及旧读重叠均不相加为首次唯一覆盖。

[首诊断](diagnostics.json)保留36b9ef（3289/预算3200）、941385（4859/4100）、699490（2641/1900）三个exit0截断。第三次runtime757–858只把明确可见757–839纳主display，旧报告随后单独1–15行确实读到。原工具transcript是首凭据，未伪造完整raw文件；后续有界静态读不是产品重试。无非零命令或late source pin。

[结束检查](ending-checks.json)9个源码/指令pins和14个精确历史命中文档均同字节，Root batch本身同SHA；未自行重核全部5676成员当前状态。[validation](validation.json)所有产品/helper/import/fixture/test/actual tool/process/native/模型/账户/网络/UI/timer/Git运行均0，没有真实用户数据或产品改动。独立 [metadata脚本](finalize-metadata.py)、[最后核对](freeze-checks.json)及 [self-excluded receipt](reviewer-receipt.json)冻结本有限结论。
