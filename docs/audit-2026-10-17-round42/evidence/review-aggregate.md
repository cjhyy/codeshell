# Root第42批汇总

本批正式记录1项P3：**TRANSCRIPT-R42-01**，预备alias TRANSCRIPT-R44-C1为同一项提升，只计一次；0新增candidate/0new-related。作者、独立反证及Root实际选读支持源码成立。该项不是实际模型/UI/异步端到端验证；没有修改产品。

普通触发是后台子代理已经产生部分text delta，随后可恢复非abort streaming失败进入内置fallback，用户查看仍可见的后台详情。Core先发tombstone撤销失败尝试，再await非流式响应，重开相同messageId并发replacement deltas。后台detailSink会先调用本translator，默认child wrapper不滤tombstone；Engine/TurnLoop实际回调链可达。当前translator164–174把tombstone与turn_complete合并，仅把旧行streaming=false并清本地指针，不删除旧partial文字；replacement另起新bg行。完整switch无assistant_message最终reconciliation。registry所读普通终态只改状态/control，不替换transcript。

实际TUI App取agent.transcript交VirtualMessageList/renderEntry，agent-scoped tombstone在主feed reduction被skip，不是对这个registry转录的清理。默认REPL为同进程transport/server/client，真实CLI bin会挂这个ui/App，不能把公共tui/index只导VERSION误当唯一入口。AgentDock只列agent，不误作内容consumer。问题影响限仍活跃后台详情中的旧撤销文字/额外行；fallback等待或后续工具仍运行时可保留，不保证每次可见、不声称已结束Dock长期可打开、持久或raw session损坏。并发同名tool_running初猜有drain整批后才发results反证，已撤回，不另报。

[作者](transcript-frontier/report.md)15当前产品/入口语义749行、旧F01报告8行=757，显示1791行，另2navigation-only/2旧full hash-only；测试正文0。Root[自己的源码复核](root-transcript-review/review.md)4产品语义263/显示361，1full3selected，均保留精确范围；后续child/registry入口证据只按作者/peer来源引用，不冒称Root重读。作者和Root/peer重叠不相加为独有覆盖。Root初始semanticSha保留null，先知peer位置之后的dedicated pin只证明在Root正文显示前，绝不回填first-ever。

[独立复核](transcript-review/review.md)自行核普通producer/consumer和外层不清理反证，其10个产品语义pins（1full/9selected）共479行、显示799行，另66行旧文档分列；7个hash/navigation产品路径及2条既有指令hash另记。其实际清单/计数独立保存；不借作者或Root读行扩大自己的范围。各报告旧native loaded-module路径、失败locator和fixture历史只作metadata，0产品/模型/事件样例fixture/测试/UI执行。只读源码顺序不是实际调度或UI帧证明。

去重明确保留同family背景：July09F01 intro明确不展开TUI，详细20–27仅Desktop turn_N/freshId相关ID不一致加最终assistant_message仅封口；当前producer已stableID并补replacement deltas，本模块独立consumer却不应用撤销。R20 StreamAttempt只审主attempt过滤，明确child临时行保留且不外推全部TUI/fallback。它们不能当当前translator同因已处理，也不发新related计数。历史表格称translator把tombstone当封口只是描述性旧材料，不抹掉它，更不声称该family首次发现。

各prep44/45 fresh3696（含冻40、排当时mutable41等）保留原时点。Root正式fresh3773=1385MD/2388JSON、1180902strings/1782213scalars，新增77冻41、0共享字节变化/0移除。Rootformal三query181/32/14 cap80不是全部读完；新增77 query90/5/0 cap120，5个focused撤销contexts全读，只是旧生命周期表格/locator副本；translator90片段未全部读。Root44自己的post-body3696 gate41focused contexts已读，首打印截断后只补读保存JSON中段；该gate不倒填为正文前gate，作者自己选前fresh gate另有证据。所有关键词/片段均不作全历史语义穷尽。

[选择复核](selection-frontier/report.md)files=[]、5产品hash-only，29路径对象与3份旧审查metadata读分列；没有实际新producer/consumer审查，也不将排除称为普通产品negative。原scope/review明确full优先于R28 unknown排名，重复方向在正文前排除；backup format的authority机制旧边界不重开。两converter只是避重复旧selected方向，未伪称旧full。Root该冻报告中一个“14/35”措辞的14没有支持，[更正](root45-selection-correction.json)明确撤回该14，仅采用旧报告35 selected source files且不是full-file声明；原12份材料及receipt不改，不把文案数字错误当产品bug。

所有冻结artifact原字节复制，Root核authoritative receipt（inactive first材料不作为当前receipt）、原freeze hash、source baseline/current/main、local links与index。无新产品重跑或替代验证。提交仅本前缀，经clean owned checkout集成；dirty primary字节前后核对，不push。worker Git0，Root Git fetch/分支/集成单列，不能说零总网络。整体审查目标保持active。
