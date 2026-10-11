# 第十二轮：搜索与导航候选独立质量复核

审查快照：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，`a66f4ef291f304ee4df9da8095a90671d9a8f140`。已读 `CODESHELL.md`。本轮仅阅读生产源码、既有 fixture 和最终日志；**未重跑测试、未新建进程实验、未启动真实模型或网络**。只写本文，不改产品、他人报告、主报告或目标。

结论：**W21 与 W22 均可保留 P3**。W21 限定普通磁盘会话尚未进入 renderer 索引、旧异步打开晚于新选择完成；W22 限定搜索覆盖不足却没有返回不完整信号。不能把它们升级为消息误发、数据丢失、不可恢复，亦不能把 W22 的有界搜索本身描述为违反设计。

| 既有证据 | 最终日志实际记录 | 本轮核对 |
| --- | --- | --- |
| navigation-stale-open.test.tsx / .log | 2 pass / 53 expect / 0 fail / 0 skip，1.405s，guarded completed | 实际完整 Core B、Main 导航校验、mounted project resolution、真实 hook/card/modal handler；有正常顺序与重选恢复 |
| search-cap-ui.test.tsx / .log | 2 pass / 14 expect / 0 fail / 0 skip，2.97s，guarded completed | 实际 catalog/search、确定 mtime 排序、5000ms 生产预算、真实 modal/hooks；有小目录、mtime 换带、截断提示对照 |

两份日志相加为已有 **4 tests / 67 expect / 0 fail / 0 skip**，与原报告一致；这是读取的原运行结果，不是本轮新增通过统计。`fatal: not a git repository` 来自真实 ProjectStore 对自有普通目录的 Git-root 探测，后续项目创建和路径 resolution 实际成功，不能算测试失败。fixture 使用 guarded HOME，Core-facing 导入前封禁 fetch/http(s)/net/tls；这一守卫仍是进程内保护，不是 OS 沙箱。

## W21：生产普通会话和导入门禁未构成反证

1. **B 确实是普通磁盘会话。** 最终 fixture 使用真实 SessionManager.create，并由新 SessionManager.resume 验证 ID、cwd、title、`origin:"desktop"`、`kind:"work"`、顶层 `parentSessionId:null`、workspace，以及真实 Transcript 写入的 user/assistant 两条消息。实际 Server listDiskSessions、PetStateAggregator 和 registerPetIpc 共同解析出 `status:"ok"` 的目标。不是仅制造一个菜单元数据或绕过 subagent/ephemeral 过滤。ProjectStore 的真实 mounted-root 校验先成功，fixture 再延迟其 IPC 完成；没有把被拒绝的路径强改为可用。

2. **SessionPersistenceGate 不是磁盘导入屏障。** `renderer/main.tsx:78–82` 确实用它包住 PetStateProvider/App；但 `SessionPersistenceGate.tsx:16–22` 等的是 initializeSessionPersistence，后者在 `sessionPersistence.ts:202–217` 调 Main catalog 的 importLegacy。`main/session-catalog-store.ts:79–104` 合并 renderer 的已有项目索引，不扫描全部 Core session 目录。App 挂载后才由 `App.tsx:1043–1047` 启动独立 useAutomationSessionImport；`app/useAutomationSessionImport.ts:127–148,169–200` 的首个 50 条磁盘页及项目 resolution 均为异步，未阻止整个 App 工作。剩余页也不自动全取。

3. **Pet 门禁也不等侧栏导入。** Main registerPetIpc 确实有 `ready:petInitialization`（`main/index.ts:2701`），不能漏掉这个门禁；它等待 Pet durable state/aggregator/long-task coordinator，而不等待 App 的 sidebar import。PetStateProvider 的 projection snapshot 和 longTasks 分别在 `pet/PetStateProvider.tsx:323–357,792–828` 获取。`PetWorldPane.tsx:168–175` 仅要求 projection 存在；`App.tsx:2251–2259` 没有 diskSessionCatalog.loading 条件。Main aggregator 在 `main/pet/pet-state-aggregator.ts:460–489` 自己翻完磁盘目录，允许其持有 B 而当前 renderer 索引仍缺 B。

4. **普通会话缺索引可达，不需要制造受限内部会话。** PetWorkDelegationHost 的生产注释和接线明确将合法委托变成普通 worker Session，renderer 是否可用只影响即时可见性（`main/pet/pet-work-delegation-host.ts:42–46,86–130`）。实时 broadcast 的 renderer 导入本身也 await project resolution（`app/useHostSubscriptions.ts:555–618`）；新窗口/启动恢复使用上述独立 disk importer。因此不能用“正常创建时会广播”证明每个窗口在任何时候都有 B。已持久化但不在该窗口当前索引内，尤其初始磁盘页尚未完成或尚未加载的后续页，是明确限定条件。

5. **新选择并未被生产忙碌锁禁止。** 真实 card 的 open 按钮在 `PetLongTaskSection.tsx:226–233` 不按 busy/navigation 状态禁用。Cmd/Ctrl+P 在 `App.tsx:1368,1386–1388` 可打开正常 picker；这里的 navigateFromSidebar 来自 useResponsiveSidebar，仅在窄侧栏开着时等待抽屉关闭后执行 action（`app/useResponsiveSidebar.ts:38–50`），不是待开会话互斥锁。SearchDialog 对已打开 modal 的键盘事件停止传播属于正常契约；本例先启动 card open、随后正常打开 picker，不依赖快捷键穿过 modal。

6. **因果和恢复均与日志匹配。** `useSessionNavigation.ts:356–359` 对已索引 B 同步选择，说明不能概括所有普通点击。对缺索引 B，`:364` await 后 `:377` 无条件 selectSession，没有检查期间是否发生新选择；createPetTargetNavigator/openPetTarget 同样没有共享意图代次。最终日志明确 C 先成为当前 bucket/project，随后 B 的旧 continuation 覆盖它。完成 B 后再选 C 的对照保留 C；错误顺序结束后再次选 C 立即恢复，背景 disk importer 完成也没有再夺走 C。

证据边界：fixture 挂的是实际 card、navigation/import hooks 和 SessionSearchModal 的组合 Host，没有挂完整 App、PetStateProvider、SessionPersistenceGate，也没有真实 Electron keydown。long-task prop 由 fixture 提供，C 的 renderer 索引亦为 fixture 初始状态；真实 Core 全量恢复断言针对 B。上述完整应用门禁和委托普通 Session 的可达性由独立生产源码补足。受控延迟证明可接受的异步完成顺序，不是测量真实机器中该窗口的发生频率。

**P3 合理**：可见影响是一次旧导航抢回焦点/会话/项目，需要重选，尚无证据表明发送到错误会话、草稿被删、Core 数据被覆盖。与 R16 的配对端广播/ACK 相关性、R29 的项目快照发布、R39 的历史编辑表单离开拦截分别独立。保留原报告的 disk-import 限定即可，不应写成“所有会话导航均错误”。

## W22：找到有界设计说明，但未找到用户可见 500 范围提示或扩大候选入口

**需要明确承认设计反证。** `docs/superpowers/plans/2026-07-23-session-world-progressive-disclosure.md:578` 规定 message-only、20MB 文件边界、8 并发、20 命中 session、3 snippets 和时间预算；`:692` 的实现样例已经写 `limit:500`，所以 500 候选并非本轮意外引入，也不能要求恢复为无界全盘扫描。该文档 `:1386–1388` 又要求截断时显示“结果不完整（已达搜索上限）”。这些事实支持将缺陷定性为**漏报搜索覆盖不足**，而不是单纯缺少搜索容量功能。

生产 `disclosure/search.ts:19,85–95` 先丢弃超过 500 的目录候选，再把 truncated 初始化 false，只在时间/命中数等后续条件更新；`disclosure/catalog.ts:47–54` 按 transcript mtime 排序后 slice，输出没有 overflow/cursor。全部 500 个被扫描完成时，search 已经无法知道原来还有候选。实际同一字段也在跳过超大 transcript 时置 true（`:110–112`），故其含义不只是“超过20个匹配行”。

实际用户入口没有隐藏参数可扩大候选：Main `index.ts:4886–4891` 只传 trimmed query 和 5000ms budget；preload `index.ts:1031–1032` 只接 query；search options 类型仅有 maxSessions/maxSnippetsPerSession/budgetMs，maxSessions 调大也只改变命中行上限，不能扩大候选。Mimi 的 Sessions action=search 在 `packages/pet/src/sessions-tool.ts:196–208` 复用同一个 helper，仍没有更大的候选带。项目/标题过滤不会先缩小该全局候选目录，content modal 也没有“更早/下一页/扩大范围”的动作。

实际 UI 的 content toggle、placeholder、hint、header 和空结果均未说明最近 500 个候选：`SessionSearchModal.tsx:95,137–146,150–188`，中文 `i18n/ns/panels.ts:247–262`、英文 `:531–546` 均如此。空输入标题模式的 Recent conversations 是独立模式；content mode 的 header 返回 Search results。唯一覆盖不足提示由 result.truncated 控制，故收到 false 时不会显示。共享 SearchDialog 的 footer 只有键盘提示。没有找到能把本例界面解释成“用户已经被告知仅搜索最近500”的提示。

最终 fixture 确认 catalog 为501且 older-target 恰在索引500，规避相同 mtime/目录顺序不确定性。真实 search 使用生产 5000ms 预算，扫描500、零匹配、truncated:false；真实 modal 展示未找到匹配内容，不显示不完整。目标在 renderer 索引中，排除了结果无法映射造成的不可用。只有目标 mtime 变新后同文本同查询被找到；小目录也能找到该旧文本。`budgetMs:-1` 只是控制组，用来证明现有 UI 能展示真实 truncated，不是缺陷触发条件。

证据边界：W22 的501条记录为 fixture 写出的普通 work state 和 message JSONL，真实 catalog/search 接受；没有对501条都进行 Core resume。该形状不替代完整会话恢复证据，但新增完整 Core 字段也不会改变候选 mtime 排序、slice 和漏传 overflow 的生产因果。Main IPC handler 本身由源码接线确认，fixture 动态调用同一 search helper，再让真实 modal/hook消费返回体；没有声称实际启动 Electron Main。

**恢复范围要收紧。** 缩短/更换查询、retry 或重开 modal不会改变候选带。标题 picker 可找已载入且未归档的旧条目；未载入时需先加载对应历史/侧栏页或使用 SessionsView 的磁盘历史标题/ID列表（`renderer/sessions/SessionsView.tsx:49–65,96–102`），然后手工查看已知会话。这些是保留访问能力的缓解，不能恢复“不知道属于哪个旧会话”的全局正文发现。fixture 的 utimes 换带只验证因果，不是给用户的恢复建议；不能要求编辑 transcript 或删除近期会话。

**P3 合理且可独立列项**：长历史目录中的空结果有误导性，但会话和原始文字都仍在，其他路径可读取已知会话。不升级为数据丢失或所有搜索不可用。修复可仅增加有界 overflow 信号并沿用已有 incomplete UI，或在现有时间预算内分页；无须移除资源边界。与 R23 的 offline root 失败、R29 的项目状态、R49 的 Collection 错误分类不重复。

## 交付判断

建议两项继续按 P3 整合。W21 的结论保留普通 disk-only/import pending 和“旧完成覆盖新导航”的范围；W22 在交付文字里明确已有 bounded/500 设计，问题是漏掉覆盖不足标志。既有四个 fixture/log 的通过、正常对照和恢复论证足以支持这两个限定结论；本轮没有新增实验，也不把完整 App/Electron 路径标为实测。


Root归档注：本轮只读复核没有新增运行；正式编号为R55/W21、R56/W22、R57/C1。已接受各项限定分级，当前主索引为准。
