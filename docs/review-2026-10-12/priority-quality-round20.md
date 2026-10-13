# 第二十轮：优先级与用户修复顺序独立核验

状态：**Completed**。本轮新增测试、原生实验、模型、网络请求均 **0**；仅阅读报告、已有证据与相关生产源码。未修改产品、主报告、既有 fixture 或计数收据，未创建新发现。

审计输入是主报告 checkpoint `d271ae8f`：77 项，1 P1 / 50 P2 / 26 P3；冻结产品基线仍为 `84740d56` 与 `a66f4ef2`。本轮抽查 **15 个原 P2**：R09/R17/R18/R24/R25/R28/R29/R30/R42/R44/R51/R53/R69/R72/R73。既有通用 79 文件 / 236 测试没有本轮增量，也没有重新执行。已读 CODESHELL.md、README“需要先修的边界”、flow-coverage 及这 15 项主证据与独立复核。

## 结论与裁定边界

13 项保留 P2 有充分依据。可重试、可重开、可重新安装，并不等于原操作已经安全恢复：要区分恢复显示、释放阻塞、重新创建已丢状态，以及重新执行另一个操作。尤其不能把服务级函数成功当成普通用户现成可见的一键恢复。

我建议 **R29 降 P3**：仅旧会话迁移的真实 await 窗口会覆写 renderer 项目投影；Main 中 A+B、迁移源权威和 transcript 均保留。普通可见项目重命名触发生产广播即可恢复；没有证明实际任务错项目执行、历史丢失或持久项目删除。

**R53 是边缘项，我保留拟降 P3 的判断，但 P2 同样有可辩护的依据**：旧插件仍工作，正式“从文件夹→重新预览→确认覆盖”无需卸载即可更新内容；另一方面，每次 reviewed directory install 都持久保存失效 source，普通 More Update/CLI Update 持续失效，替代安装没有恢复更新契约。分歧是修复排序与重要性判断，不是事实矛盾。

主审在收束消息中已裁定 **采纳 R29/P3、保留 R53/P2**。此裁定合理；本报告仍保留独立审计的边缘建议。仅这次分级变更对应的总数应为 **77 = 1 P1 / 49 P2 / 27 P3**，由主审更新正式索引，本审计不修改它。R37 正式是 P2；此前消息混写 R11/R19 的 P3 与 R37 的范围限定已澄清，没有将 R37 纳入降级建议。

## 15 项抽查

以下“已验证”均指既有归档实验，**不是本轮新增运行**。源码位置使用各主证据已核验的冻结基线行号；跨基线偏移不据此冒充相同运行结果。

| 项目与建议 | 可证明的重要影响 | 恢复入口及实际代价 | 证据位置与限制 |
| --- | --- | --- | --- |
| **R09 保留 P2** | 第二个 Hub 启动在 bind 失败之前删除第一实例仍在用的 upload spool；第一实例仍健康，附件暂存字节已不存在，后续 staging 失败。这是资源保管破坏，不是一次启动报错。 | 可重新上传仍在用户手中的原文件，但那是重新创建已删除暂存资源；刷新、重开页面不能找回 spool。未声称用户原文件被删。 | [server-round1:6](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/server-round1.md:6)，核心 uploads.ts:66–68、Headless 构造 cleanup 早于 listen；[resource-quality-round8:7](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/resource-quality-round8.md:7)。真实完整认证 Hub 重复启动控制，不扩到不同 dataDir。 |
| **R17 保留 P2** | 删除所有 chip 后服务仍占满 owner 16 槽，空 composer 的新附件实际 429；正常替换附件流程不能继续。 | 本地删除/重新选择不释放；15 分钟 TTL/sweep 或重启回收。新登录至多绕 owner，仍受全局 32 槽/128 MiB 限制，不是可靠恢复。 | [server-round1:29](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/server-round1.md:29)；useHubController.tsx:734–736、uploads.ts:87–92。实际 SessionDrafts 与真实上传服务；两行正式 removeFile 接线源码，不冒充完整浏览器点选 E2E。是有界配额阻断，不是无限泄漏。 |
| **R18 保留 P2，P2 内后排** | 成功/陈旧 CLI probe 后发生真实异步 spawn error，失败 child 仍被当成 running；修好 CLI/路径后同模式 reopen 不 spawn，发送持续 false。正常失败后的核心重试路径失效。 | RoomManager 的显式 close 后重开、切换模式实际重建成功；Main 重启清内存为源码恢复推断。**这些是服务级控制；当前 renderer/Web 直接可见 close/改模式恢复未动态验证**，不能称一键恢复。 | [server-round1:40](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/server-round1.md:40)、[cli-quality-round9:61](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/cli-quality-round9.md:61)；resident-agent.ts:207–218、236–238，room-manager.ts:1009、1212–1225。fresh missing CLI 通常被 probe 挡住；同步 throw/正常 exit 已清理，不在缺陷内。 |
| **R24 保留 P2** | 项目先 tombstone，cold/evicted durable worktree owner 后续释放失去项目权威；旧 owner 继续占用，正常清理拒绝 occupied。不是 UI 单行消失。 | 已验证重加同一原项目→Settings 恢复旧会话→再次归档，释放 owner 后才能安全清理；真实 Git/生产 helper 对照。多步骤恢复依赖重新建立合法项目权威，普通刷新不能完成。 | [README:139](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/README.md:139)、[workspace-quality-round11:53](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/workspace-quality-round11.md:53)；useSessionNavigation.ts:138–146、session-workspace-service.ts:563–592。真正 resident helper 能先脱离，不能泛称所有移除项目均失败；服务组合不是完整 Electron 点击验收。 |
| **R25 保留 P2** | 两个旧完整默认模型表单顺序进入已释放的配置门禁，第二次保存把用户没有改动的另一个默认值回滚；两边都报告已保存。是 durable lost update。 | 读取最新状态后再次选回正确值可修复，但用户原成功设置已被静默覆盖，重试原旧表单会继续携带旧字段；没有冲突提示帮用户识别丢失。 | [web-round2:19](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/web-round2.md:19)；HubSettings.tsx:669–674、configuration.ts:213–232。完整认证 Hub 正常顺序提交；不是两个 mutation 同时执行。后续实际使用哪个模型是配置接线推断，没有真实模型调用或费用实验。 |
| **R28 保留 P2** | 插件行已可操作，初始权威禁用数组尚未到达；切换 beta 把原 alpha/alpha:skill 禁用项永久覆盖为空/另一数组。旧初始化响应还可反向绘制。 | 重开页面仅恢复正确显示，不能还原丢掉的禁用项；必须知晓原设置后手动重禁用。配置文件完整性锁不能恢复数组成员。 | [desktop-quality-round10:58](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/desktop-quality-round10.md:58)；ManagePage.tsx:70–83、104–120；PluginsTab.tsx:82–123、460–463。实际 Main writer 落盘；等待来自 renderer IPC/异步 settings read，不称 Main 两次同步扫描并行。项目 deny/trust 仍有效，不声称任意恶意插件执行。 |
| **R29 拟降 P3，主审已采纳** | legacy bucket migration 等待实际 persistence.flush 时，新 Add Project B 的广播先到；旧 A 快照随后只改 renderer 投影，active B 仍在。Main A+B 及历史源保留。 | 动态使用 actual hook 对**仍可见 A**重命名，实际 store 广播恢复 A+B、保留 active B；无需退出。Open Recent 重读 registry 的补救为静态入口，未运行原生点击。 | [desktop-quality-round10:68](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/desktop-quality-round10.md:68)；useProjectRegistrySync.ts:32–43、49–62；transcripts.ts:800–806、821–830；useSessionNavigation.ts:174–179；App.tsx:1434–1442。狭窄升级迁移窗口、可见投影且普通事件可恢复，与 P3 迟到导航/跨窗选择更接近。没有实际 run、错项目执行或 transcript 删除证据。 |
| **R30 保留 P2** | executor 已结束，但真实 EACCES 终态写入被吞，内存/磁盘仍 running、终态 result/error 缺失；activeCount=1 使重试及配置门禁持续被阻塞。 | 修复磁盘权限本身不补写；显式 service cancel→retry 或新 Host 将旧 checkpoint 标 interrupted 可解锁。取消并重跑不会取回原终态结果。 | [runtime-round3:6](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/runtime-round3.md:6)；tool-jobs.ts:430–434、768–774、806–830；[resource-quality-round8:33](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/resource-quality-round8.md:33)。结果指 ToolJob 终态字段，**不是证明所有输出文件丢失**；service cancel 不等于每个 Panel 都有可见取消按钮。 |
| **R42 保留 P2，优先于一般重试问题** | 两条正常新增 Cookie 账号流程生成重复 ID，实际 CredentialStore 整体替换旧 cookie jar、标签、权限/策略；有正常成功反馈。 | 旧账号必须重新捕获/登录并恢复策略；给旧账号重命名不能改变 ID，重做新增还可能再次冲突。不是重新打开设置即可恢复。 | [credentials-round5:5](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/credentials-round5.md:5)；CookieTab.tsx:102–109、171–189、239–245；store.ts:368–384。实际 Electron/IPC/store，jar/login 来源受控，非真实账户或 keychain；不声称已打开浏览器立即退出。与 R43 保稿可同值重试的 P3 明确不同。 |
| **R44 保留 P2，靠前** | 120s 整轮超时后 scheduler 提前放开同 job 保护，真实 ChatSession 仍 busy；存活的非 once 任务再次触发会 FIFO 排入同一提示，首轮后重复执行。 | 暂停只阻未来触发，不能撤销已入队意图；相关 abort controller 已被清。Core cancel 清队列的接线是源码可用控制，不是证明普通自动化详情按钮能撤回每份旧请求。 | [automation-round5:9](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/automation-round5.md:9)；Main index.ts:3518、handle-client-event.ts:131/166/180、scheduler.ts:1173、server.ts:2034/2068；[automation-quality-round18](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/automation-quality-round18.md)。生产闭包+真实 FIFO，120000ms 压为20ms、fake Engine；无真实副作用/模型，非同一 Engine 并发。once 结算删除不重报同 id 再入。 |
| **R51 保留 P2，P2 内后排** | 正常卸载已完成并删除 registry/目录，但旧 installed job 使市场详情显示已安装并禁用 Install；服务端也直接返回旧完成 job，不执行 reinstall。缺失插件的正式安装入口持续不可用。 | 页面重挂/12s badge 消失不清 Main job map。空 marketplace job map 的新 service control 能重新安装；这是 Main 状态重置的控制，**不是实际 Electron restart 实验**。源码上重启可解。 | [plugins-round7:17](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/plugins-round7.md:17)、[plugin-quality-round9:7](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/plugin-quality-round9.md:7)；MarketDetail.tsx:92–110、164–166、195–203；marketplace-service.ts:473–481。相比 R53，用户当前已无该插件、正常安装入口也无法使用；不只是“已安装”标签错。 |
| **R53 边缘拟降 P3；主审保留 P2** | reviewed folder install 把随后删除的私有 snapshot 记为 durable source；原目录仍有效，More Update/CLI Update 确定性 missing。旧 v1 文件/registry 保留且仍可用。 | 实际生产 review 服务证明原目录重新 preview+显式 overwrite 成功到 v2，同安装路径、registry 一条、无需卸载；但新 metadata 仍坏，下一次 More Update 再失败。刷新/重开不修 provenance。 | [plugins-round7:66](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/plugins-round7.md:66)、[plugin-quality-round9:33](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/plugin-quality-round9.md:33)；preview.ts:468–485、install.ts:47–55、update.ts:137–159；PluginsTab.tsx:232–254。P3 理由：旧功能未失、更新内容有正式 UI 替代，影响主要反复重选/审查。P2 理由：公开 Update 的支持契约持续损坏，替代重新安装没有修好它。**不建议去掉 immutable review 防护或改成未审查 direct install**，也不概括 ZIP 更新。 |
| **R69 保留 P2** | 旧 secondary B 物理缺失、健康 A 已通过 target 校验，正式“修复到 A”仍因构造全 roots 再校验旧 B 失败；removeRoot 又正确阻止删除活跃绑定。专门恢复缺失根的主入口被旧根存在性阻断。 | 恢复 B 原路径后同按钮动态成功。B 无法恢复时 archive→remove bad root→restore→migrate 为**服务级组合验证**；未点击完整 Desktop 组合流程。普通重试/重启不会让坏目录回来。 | [project-recovery-round16:5](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/project-recovery-round16.md:5)；project-store.ts:358/367/886，Sidebar.tsx:1079/1111，project-authority-ipc.ts:107。实际组件/Main/cold durable branch，无 resident worker/完整 preload/Electron。没有历史/文件删除；安全修复须保留 owner、target、root 身份门禁。 |
| **R72 保留 P2** | Settings 取消归档只更新 desktop catalog；Core archivedAt 持久保留，恢复行可见却不再参与 live root binding 保护。正式 folders UI 可移除它仍绑定的 secondary，随后实际 resolver 拒绝 root_removed。 | 正确 navigation/Main restore primitive 动态可清 marker、恢复 root guard，**没有证明纯 Desktop 可见 workaround**。再点 Settings 仍漏 writer；root 已移除后只清 marker 不够，还需重新挂载/迁移。 | [session-operations-round17:30](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/session-operations-round17.md:30)；App.tsx:2723–2728、2747–2752；workspaceArchiveRelease.ts:26–41；project-store.ts:195、312–322。组件/真实磁盘/实际 Main callback；没有发送后续真实 worker/run，没有文件或消息删除。不同于 R39 已真正恢复后额外一次离开确认的 P3。 |
| **R73 保留 P2** | 合法 configure 异步等待时，回答先 submit lease 再遇配置 busy 早退；没有向 worker 派发，却永久留 submitted。UI 到期后重试失败，重连 snapshot 排除旧问题，常规重试不能交付。 | 现有卡页面 actual controller Stop+分层 Core cancel 可取消旧题，之后 fresh question 新 id 可答；是**取消重问，不是恢复原答案**。worker exit 清 leases 仅源码；没有给 submitted 设置 TTL。 | [server-routing-round17:9](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/server-routing-round17.md:9)；headless-server.ts:945、969–981；approval-lease.ts:41–50、69–78、100–105。真实 auth HTTP/WS+React 卡片、内存 worker；独立 actual AgentServer/ChatManager 配 fake engine/runtime。完整 Workbench Stop 按钮只核接线，真实 Engine no replay 为源码衔接。无历史损坏/跨会话执行。 |

## R29 的权威与发送边界再核

renderer 的 `activeProject = projects.find(...) ?? null` 位于 [App.tsx:298](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:298)。B 从当前投影缺失时会影响项目显示及传给 hook 的 root 可用性，但 `useActiveSessionUiAuthority` 使用具体 session 的 Main authority；其 project fallback 也依据实际 `projectPrimaryRoot` 是否存在决定 configurationAvailable，而不是直接把 A 当成 B。相关位置是 [sessionUiAuthority.ts:268](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionUiAuthority.ts:268) 与 [sessionUiAuthority.ts:169](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionUiAuthority.ts:169)。

这些源码仅用于排除“active B + visible A 必然将任务发往 A”的过度推论；既有 fixture 没有完整 App/send 实验，不能据此宣称所有新草稿保护均动态验证，也不能把潜在暂不可用扩大成跨项目执行。实际已证事实足以保留缺陷，但不足以支持更重风险措辞。

## 决策价值与用户修复顺序

[flow-coverage:25](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/flow-coverage.md:25) 以数据风险和用户能否继续任务排序的方向正确。建议实际修复队列进一步区分：

1. **先修 R35/P1 的创建/回滚资源归属**；本轮没有重审或降低这项。与其并行优先处理不确定回执、输入/会话身份、权限投影与审批请求身份等已知 P2，避免真实意图重复或错误归属。
2. **本次样本中，先处理状态/意图已经改变且简单重试不能撤销的项目**：R42 的凭据覆盖、R44 的重复排队、R25/R28 的静默配置覆盖、R72 的 durable restore/authority 失配、R09 的 live spool 删除。R73 的原题无法正常交付和 R30 的终态丢失/假 busy 应紧接处理；不要把取消重问/重跑写成原操作已恢复。
3. **再处理恢复路径与配额阻断**：R69 的缺失根修复、R24 的 cold owner 释放、R17 的空草稿配额。它们没有用户文件删除，但工作流确实中断，需要路径恢复、多步权威修复或 TTL/service 重启。
4. **P2 后部处理持续失效但保留替代路径的生命周期功能**：R18 spawn 句柄退役、R51 卸载后重装、R53 reviewed 更新来源。R53 即使保留 P2，也不应与 R42 的已保存身份覆盖或 R52 的工作插件文件删除同等紧急。
5. **R29 随其他 P3 投影/导航恢复改进处理**。修复仍应统一初始快照与广播版本，不能用重命名/重启 workaround 替代根因修复。

这只是所抽样项的相对顺序，不声称覆盖全部 77 项、估计修复工时、证明影响发生频率，或预测真实费用/文件副作用。

## 报告措辞核对

未发现需要撤销既有动态事实的实质矛盾。需要保持的边界如下：

- [README:135](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/README.md:135) 的 R18“显式 close 或更改模式……现有恢复入口”不能自动解读为当前可见 UI 一键操作。已向主审建议明确“服务级验证，当前 UI 恢复入口未动态验证”。没有找到实际 renderer/Web 直接调用 `ccRoom.closeSession` 的入口，既有 generic externalRuntime.stop 也不能未经验证当成同一 RoomManager 的恢复。
- [README:147](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/README.md:147) 的 R29 renderer/Main 分歧事实成立；降级只调整严重程度，不否认真实迁移等待。第十轮“保留 P2”是当时审计判断，应由本轮裁定覆盖，而不是把两轮文字合成新的事实矛盾。
- [README:187](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/README.md:187) 已正确补 R53 无需卸载的 reviewed overwrite。不能继续写“插件完全无法更新”“旧插件已删除”或“必须卸载才能恢复”。现有 source/provenance 的持续失效又不能被该 workaround 掩盖。
- R25 后续模型选择、R28 潜在 hook 使用、R44 真实外部副作用属于源码或可能影响，没有实际 provider/账户执行；P2 依据分别是 durable 配置覆盖和实际重复入队，不需要把这些扩成已观测收费/危险执行。
- R24/R69/R72 的服务级恢复与真正 UI 可见恢复应继续分开；R30 的 result 指终态字段；R51 fresh service 代表进程内 map 重置；R73 cancellation 只结束旧题。专项现有边界基本准确，不宜在最终摘要压缩掉这些限制。
- R37 保留 P2 的 freshNative 窄例外已在 [README:163](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/README.md:163) 明确，未发现本轮把它混为 R11/R19 的 P3。

**最终：Completed；15 项原 P2 样本；13 项直接支持保留，R29 拟降且主审采纳，R53 边缘拟降观点保留但主审裁定保留 P2；新增执行 0、发现 0、产品修改 0。**
