# /cost客户端与账本分离假设：Root80定向反证

有限结论0正式、0候选、0关联；撤回“普通远程TUI的/cost读取本地空singleton”假设。Root74观察到命令直接使用costTracker而App走client.query，仅此不足以证明两套账本。没有将待反证想法计入正式问题。

实际CLI两种interactive入口均调用replCommand；main64的--base-url明确为LLM API URL，interactive参数只有resume/prefill，没有在这条路径找到remote Engine入口。repl258同进程transport pair，281用clientTransport构造客户端，323–331将它交UI。更关键的是215 `sessionCostTracker = costTracker` 是同一全局对象，223交EngineRuntime；runtime54–60正把usageLedger绑定回这一对象。CostTracker95–96取得绑定summary，/cost94–96先走该支路，因此正常入口不满足空未绑定前提。

useSessionUsage23–44确实query session usage，但不是远程网络已接入的证据。不能以任意providedClient/自建SDK调用制造当前产品普通consumer；也不认证其他embedding/远程API、协议、身份、锁、生命周期、真实计费或模型。runtime cost与session cost本来可以范围不同，不据此报错。原COST-R9-01是未绑定standalone估价模型ID丢失，原记录保留；不重报也不借旧runner当本次测试。

本包为已知假设的定向选段，不是盲审或未读frontier；hook旧sameSHA fullR7不改。source manifest中的semantic/display分开，相邻pricing/API-key/permission/setup/native/lifetime字段仅展示边界，未执行、未认证。0产品/React/clock/timer/client.query/transport/账本/provider/helper/fixture/测试/真实模型/native/业务网络运行，Git0（外层Root整合另列）。

fresh4492=1442MD+3050JSON、1953735strings/2921270scalars，纳冻48排49–82；宽路径/SHA/94精确source对象未全读，remote-cost0只是机器检索无匹配，非历史语义穷尽。实际读取原COST一对象作为旧因区分，当前主要反证来自真实入口源码。[assessment](assessment.json)、[source manifest](source-manifest.json)、[ending](ending-checks.json)。8pins和4492历史文件结束字节全同。最初文件名导航含不存在renderer/hooks目录、pipeline上游退出码未保存的限制原样记录，不算产品失败；后从已确认父目录做文件名定位，未用部分输出声称全清单。
