# Shortcut hint text helper — future42 prep

本次有限静态结果是 **0新增 formal / 0 candidate / 0 new related**。唯一 active leaf 为 `packages/desktop/src/renderer/keyboardShortcutHints.ts`，全文9行。已读普通显示调用与测试声明没有建立新的文本拼接反例；这不代表实际快捷键处理、菜单、窗口或平台运行均正确。[分类](classification.json)明确范围。

初始候选 web/lib/format.ts 在读取正文前排除。旧 Round28 coverage 将其当前 SHA 归为 pin-only/unknown，但 fresh gate 找到 Round20 manifest 同 SHA 行的明文 scope：Full static module。直接资料比结构化分类标签更强；没有据 pin-only 声称从未读过，也没有重开该模块的项目归属/identity 旧问题。早期117行旧版本全文阅读与当前140行版本分账。core/utils/format.ts 在 metadata 排名时已有同 SHA full1–300，未成为 active leaf。其他 metadata 候选只核行数/hash，均没有正文阅读；最终只替换一次。

替换9行 helper 的函数合同很窄：平台值为 darwin 时，text 风格拼 Cmd+，symbol 风格拼 command 符号；其他平台值或 undefined 拼 Ctrl+，再原样追加 typed key 文本。Sidebar 显示段传入 preload 平台值、序号字符串与 symbol 风格；CommandPalette 的显示字段传 B/F，以及 mac 条件下的 I/Shift+N。只核普通提示字符串的拼接与显示接线，没有运行回调，也没有把提示文本当作真实 accelerator 生效证据。

现有18行测试只读：一个 test.each 的3行平台表和一个 fallback test，声明覆盖 darwin、win32、linux、undefined/browser 的普通输出。0测试/import/语言 fixture 执行。旧 R12 报告曾关注并测试该 helper，表明这里不是未审领域；旧23pass/39expect属于过去包含3文件的 shard，未借作当前结果或本 helper 专属计数。

[源清单](source-manifest.json)记录4个 active语义 pin，2full/2selected，共59行＝41product＋18existing-test declaration；另有5个metadata排名/排除产品hash pins和2个既有指令hash核对。9产品与2指令结束字节均匹配。所有实际选段在对应专用 pin 后读取。打印过的归档按钮、relative time、其他 palette 导航项、native/window 回调邻接代码没有纳入机制审计或调用。全局新增覆盖不与旧R12重复相加。

独立 fresh history gate 遍历 docs/bugs 全MD与递归JSON scalar values，含archives、冻结38，按任务时点排 mutable39/future40/41/42：3509文件＝1361MD＋2148JSON、975542string values、1464542scalar values，0parse errors。初始 path/lib-format/SHA命中67/75/12均全保留；宽format group399命中仅保留cap160，没有声称全读。前3组按完整context文本去重为23段，随后完整读完，9个同SHA对象也已核。一次过长locator数组打印截断的首诊断保留；最小header版本完整输出23段，未运行产品补证。[原扫描](history.json)与[实际上下文](history-selected-contexts.json)保留方法和记录。

同一3509完整值库存对唯一替换重新匹配，path/filename/SHA/ordinary-contract命中5/18/7/0，均低于cap120，6段unique context和5个同SHA对象完整读完；与初始库存字节无变化。[替换gate](replacement-history.json)保留原结果。旧 manifest hash行没有明确full/selected语义字段，不能推出过去未读；全部历史关键词匹配也不是全部历史文档语义阅读。[历史判定](history-decisions.json)保留这些区分。

扫描时已知最高冻结批为38；Root39后续整合不会被倒填到此次 dated扫描。formalBaseline为null，未用Git认证未来状态。release TODO从本次初扫起已199956B /8c1b9ca…，不是借用或重标旧parent3509；[结束检查](history-finish-check.json)显示本次3509路径集与字节全一致。175仅为路径含archiv的substring计数，不冒充exact archive目录计数。

[validation](validation.json)记录产品/helper/import/语言fixture/测试/React/真实状态/键盘菜单或命令/native/network/模型/identity/权限实验均为0，Git与repo写入为0，旧失败方向均未恢复。写入仅本exact tmp目录。只给出普通修饰键提示文本的有限negative，没有“全部快捷键/自动化/项目无bug”的结论。[artifact receipt](artifact-receipt.json)自排除避免递归哈希。
