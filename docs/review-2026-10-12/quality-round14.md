# 第十四轮整合文档最终只读语义核验

结论：**保留 R63、R64、R65 的 P3 与 R58 的图片扩展；无需撤销或重新分级。最终五份文档没有未解决的实质语义矛盾。** 审计中通知主审修正的三处文案/路径均已只读确认完成。本次未运行任何测试、Electron、模型或原生实验，未改产品、主报告或目标，也未创建子代理；只写本 `/tmp` 审计文件。

核验对象为 `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/` 的 README、flow-coverage、notification-round14、terminal-lifecycle-round14、file-navigation-round14。辅助只读对照各附录所链的生产源码、fixture、既有成功日志、两份 reproduction-results JSON、notification-quality 与 Electron reload-identity 源码/JSON；没有将只读复核额外计入测试。

## 统计与基线

- 主报告正式表格实际为 **65 行：1 P1、44 P2、20 P3**。R63–R65 各一项 P3；R58 图片未另加编号。
- 两基线 `validation/reproduction-results.json` 和 `validation/latest-a66f4ef2/reproduction-results.json` 各 **62 条、199 测试**。逐条只读核对所指向日志的 `Completed Bun shard`，均与 tests 字段一致，最终 code=0、skipped=0、failures=0，无缺失或不匹配。旧失败和重跑诊断不代替最终完成记录。
- 第十四轮两套原始成功日志分别为通知 **3/19**、终端 **6/41**、Desktop 文件 **3/48**、Hub 文件 **1/22**；每套合计 **4 文件、13 测试、130 断言、0 fail/skip**。199 是同一套通用测试在各基线分别执行的数量，没有再加成398；本轮13已在199内，不另加一次。
- 原始代理仅运行 a66f 的文件/终端说明，与主审后续两基线复跑不冲突。file 附录末节明确区分原始范围与后续复跑；terminal 附录现也明确原始固定 latest、当前便携副本 cwd。通知按最终3/19计数，未加早版3/18。

## 结论与证据范围

**R63：保留限定 P3。** 普通通知必须已经耗尽生产5/10,000ms额度，且第六条已进入持有 mutationQueue 的等待，后到 urgent 才被挡。额度饱和但无普通等待时，urgent 正常不 sleep 的控制存在；附录没有泛化成所有 urgent 受限流。真实 bus → background route → notifier 的动态链，结合 Main 内 headless Engine 的 Agent 可用性、6个后台 Agent 上限及同进程 bus 的静态接线，足以支持生产可达性；未借 worker 的另一份 bus 证明 Main 条件。没有运行六个真实模型或完整 Scheduler，正文明确说明。默认10秒由注入 clock/sleep固定，未当实测墙钟或全局最大延迟。最终表述限定本例七次 show/receipt 完成，实际 OS 呈现未测；未声称永久丢通知、错报执行结果或任务重复。与 R45 根因独立。

**R64：保留条件明确的 P3。** 实际 a66f/macOS Electron 身份补证只运行普通 reload，三次 snapshot 的 token、rendererPid、WebContents ID 保持，Main realm 直接比较 WebContents 对象相等；JSON 明确 workerCreated=false、terminalOpened=false、actualPtyStarted=false。另一套组件/Main/preload/pty-service fixture使用 native adapter 替身，观察恢复 terminal-1 在首次分配新ID前被关闭、随后重用相同 key并连接旧 entry，额外关闭重开使用新ID、没有旧scrollback。源码显示普通 reload 不触发窗口closed reap，支持两个证据的条件组合；正文多处明确它不是完整 native terminal重现，不支持所有crash、导航或平台保持token，也不宣称真实shell退出/命令/cwd/泄漏。恢复有明确“旧PTY尚存活、same owner/token、首次新ID分配前”的条件，再次重开恢复。README/流程图保留简述，附录补足限制。

**R65：保留 P3。** 实际 FilesPanel 和生产 Main AST→真实 project/root authority→fs.readdir 的非root owned-directory EACCES，与真正空目录在UI均无子项/失败提示；文件保留，修权限刷新恢复。动态证据是 project-root 模式，Session 模式同catch仅静态关系，附录没有把它冒充第二份动态证明。没有数据损失或无法恢复主张。与预览组件已有错误反馈是不同路径。pending旧目录行的观察没有升级成跨会话执行或损失。

**R58 图片扩展：同根因合并正确。** 合法真实Git managed worktree 的 Session authority、目录与文本正常，PNG点击落 `images:readDataUrl` 的 project-path gate；primary和registeredsecondary正常，任意未注册root拒绝，补sessionId仍在cwd gate前失败。与PTY门禁缺少Session authority是同类已报告边界，不增加编号。普通当前worktree图片点击/刷新不自动调用single-file。恢复限定**切回main后显式打开原worktree绝对文件链接**，使文件落在当前根外再走显式单文件授权；README现已补此前提，不能解读为留在worktree内重点击绝对链接即可恢复。其他图片组件调用只静态核对，没有附加未运行组件的动态声明。

Web 文件正常对照明确是实际文件服务的fixture授权回调，非再次完整配对登录；迟到A通过受控transport在真实HTTP正文完成后暂缓，故意忽略该请求abort以检验组件guard，正文没有把它冒充自然浏览器竞态。POST405、移动404、拒读403、修复后重试与auth撤销401均与测试和源码一致。SessionPanelDock按bucket隔离的静态说明也避免了非生产换props场景误报。

## 已修正文档项

1. file-navigation附录的运行命令原从checkout根指向不存在的 `reproductions/...`；主审已改为 `docs/review-2026-10-12/reproductions/...`，terminal命令同样已修。只读确认路径存在，未执行命令。
2. README第十四轮R58恢复摘要原漏“切回main”前提；主审已补，现与文件附录和实际fixture一致。
3. terminal附录原称“当前脚本固定latest、需改cwd”，而归档副本已经cwd；主审已区分代理原始脚本与当前便携副本，现与末节两基线复跑一致。

最终主报告、流程覆盖和专项附录对正式编号、恢复条件、原生证据层次及测试统计一致。尚未覆盖的完整nativePTY/OS通知/实际提供方行为仍清楚列为证据边界，未作为已通过范围。
