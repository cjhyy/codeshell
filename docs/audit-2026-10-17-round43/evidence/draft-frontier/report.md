# Future47 — Desktop composer ordinary-data frontier

**0 新 formal / 0 新 candidate / 0 新 related；精确旧因排除 1 项 R04/D5。** 本轮选择2622行 [ChatView.tsx](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/ChatView.tsx) 的受控草稿、键盘历史与异步展开选段，结合真实 App callback，未建立新的普通 UI 数据反例。不是只查小标签 helper，也不是整组件或全仓无 bug 结论。产品及正式 docs 不改，只写本 exact tmp。

真实输入链是 textarea2233受控 value=draft，2236–2256 onChange→setDraft483–489→[App418–425](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/App.tsx:418)的 functional draft-map text update；App2649–2650把当前 draft 与 setter交回 ChatView，2603–2611为普通onSend callback。只评这些字段和普通前端数据更新，不评 bucket身份/authority、后端投递/失败恢复或附件staging机制。

所读键盘路径1341–1440先检查isComposing和native composing flag；一般编辑会退出historyCursor，空草稿/历史浏览才接受历史导航；Up有空历史保护和clamp，Down下溢恢复stash。项目/variant/localRuntime变化会重新取历史并清cursor/stash。seed effect873–888对非空稿functional追加段落边界。忙碌但无queue callback的嵌入variant直接返回而保留稿。没有构造NaN、非法索引或任意坏DTO，也没有执行React/DOM键盘或输入法fixture；这些仅是当前所读正常分支的静态negative。

异步插件展开初看可能覆盖用户后来编辑，但inputDisabled940/2292包含expandingPluginCommand，不能拿“同一输入框展开时继续键入”凑新问题。进一步看到await后只有mountedRef guard，而App setter按当前activeBucketRef写草稿，切到另一对话的旧稿确实需要检查；fresh历史马上命中精确旧记录，故不新报：

[原D5](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/review-2026-10-12/desktop-round1.md:58)58–68明确同样的plugin expansion待回包、同一ChatView保持挂载、切到B已有草稿、late result写B；[独立R04](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/review-2026-10-12/desktop-quality-round10.md:24)24–32又精确解释App无key、mountedRef-only、activeBucketRef.current及输入disabled不阻止侧栏导航。这是完全相同的producer/consumer/丢稿条件，不只是与旧R36 popout active-ref的类比。当前源形状只用于同因对应，不重做旧IPC/native/React测试，不改变旧分类或声称当前运行状态已重新证实。旧pass/guard/authority文字只是邻近历史材料，绝非本轮运行结果。

先做的全历史gate包括冻结41，排mutable42及future43–47，含archives：**3773=1385 MD+2388 JSON，1180902 JSON strings/1782213 scalar values，169 exact archive/_archive，0 parse错误**。MD全文与所有递归JSON value scalars参与查询，keys不搜索，原scope/ranges/full说明优先于R28排名。ChatView current-SHA旧明示覆盖主要是R9 attachments250–410/1115–1235、R27 selected231–242/370–390/1760–1824、R36 selected1568–1591/1753–1825，R6仅model相关搜索命中或pin；没建立current-SHA full receipt不表示历史未读。大文件剩余部分也不因本轮查过选段就变成已审。

初查ChatView224/Sidebar192均cap100，SHA命中34/26，未选CommentBox5/SHA4；精确数量和库存见 [history](history.json)。后续同3773库存 [focused gate](cause-history.json) 的plugin-symbol/draft-plugin-race/active-ref-draft=0/105/2，保留0/100/2。字面函数名0不代表旧因不存在，后两查询找到了上述同因。实际解释12次bounded窗口、11个去重value/paragraph unit；不把100 retained、宽AND巨JSON scalar或全历史当语义穷尽。R36旧report全文19行表明其重点是anchorBuckets/followState及选段consumer，不能当整个ChatView或plugin async的完整审验。

[source manifest](source-manifest.json) 的5个真实语义rows包括2个current产品选段448行、3份旧报告39行，共487；742行显示里有附件staging、原生录音清理、权限/model等相邻文字，全部按明确普通范围计数，不能当这些机制已审。Sidebar/CommentBox各只hash，2测试文件只导航标题，没有测试body语义阅读、import、render或运行。peer自己的历史排除意见不算本作者新增产品阅读，旧覆盖重叠不夸为新独有覆盖。

本次发生一次 metadata focused-method编译前SyntaxError（`else0`缺空格），[原method](cause-history-method.first.raw.py)与[exit1诊断](cause-history-method.first.exit.json)保留；修正仅此metadata typo后才第一次真正扫描，未重试产品。另一次exit0的locator打印被tool预算截断，saved JSON/counts完整，不宣称其全部contexts都读完。限制见 [metadata notes](metadata-notes.json)。

[结束检查](finish-checks.json)核9个source/navigation/hash-only路径与原3773库存集合/bytes均不变；不重写原snapshot时点，不把Root报告的5dcd当本reviewer独立Git绑定。0产品import/helper/函数、Buffer/语言/timer/Promise/事件fixture、测试、React/browser/DOM、真实业务或输出文件、网络/native/模型/进程/身份权限实验，Git0，旧TUI Diff/Question/compose-import等失败方向仍skip。分类与边界见 [decisions](decisions.json)，终态收据见 [artifact receipt](artifact-receipt.json)。
