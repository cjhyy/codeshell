# 真机冒烟 Checklist(总)

> 一处汇总所有**待真机冒烟**的功能。自动化(tsc/build/单测)测不到的渲染、IPC、重载时序、跨进程行为才放这里。
> 跑法:仓库根 `bun run dev`(desktop);开 `~/.code-shell/logs/`(`scripts/logs.sh`)边操作边看 `stream.event` 等日志。
> 验完一项就打勾;整组通过后该批可 push。**新批冒烟项往本文件加 section,不要再新建独立 checklist 文件。**

最后更新:2026-06-23。

---

## 1. Goal 加载回灌(commit `645e0332`,未 push)

修「持久 goal 关了/重开后页面不显示、取消不了」。核心验「关 app / 清 localStorage 触发磁盘重建」这条路。

- [ ] **1.1** 设一个 goal(引导模式发带 goal 的消息)→ 顶栏 StatusPopover 出现 Goal 块。
- [ ] **1.2** goal 跑一半 Stop/中断(会话变 aborted)→ 刷新 / 切走再切回 → Goal 块 + Cancel 按钮仍在。
- [ ] **1.3** 点 Cancel → goal 真清(Goal 块消失);再刷新确认没复活。
- [ ] **1.4** 关 app 重开(或清 localStorage)→ 打开有 goal 的会话 → Goal 块从磁盘 state.json 回灌出来。
- [ ] **1.5**(关键 bug 场景)对一个 aborted 旧会话(如 `s-mqqa4nio-9faac9db`,磁盘 state.json 里有 `activeGoal`)→ 打开 → Goal 块 + Cancel 出现 → 能 Cancel 清掉。
- [ ] **1.6**(回归)没有 goal 的会话打开 → 不凭空冒出 Goal 块(goalGet 返回 null 不画)。
- [ ] **1.7**(不覆盖)localStorage 本就存着 goal 的会话刷新 → round 进度没被回灌重置(仅 activeGoal===null 时注入)。

关联:`project_goal_rehydrate_on_load`。

## 2. Todo 任务面板磁盘重建(commit `eadb9ef8`,未 push)

修「TodoWrite 任务面板关了就没了」。todo 只活在 TodoWrite tool_use 的 args 快照里,磁盘重建时 reader 要补发合成 task_update。

- [ ] **2.1** AI 用 TodoWrite 建多项任务 → 面板显示任务列表。
- [ ] **2.2** 同会话内关闭再重开(localStorage 还在)→ 面板还在(确认没坏)。
- [ ] **2.3**(关键 bug 场景)关 app 重开 / 清 localStorage 触发磁盘重建 → 打开会话 → 面板从磁盘 transcript 重建出来,内容/状态(pending/in_progress/completed)正确。
- [ ] **2.4** 一个所有项都 completed 的 TodoWrite 会话,磁盘重建后 → 面板清空(「全完成⇒清空」,和 live 一致),不是一堆划掉的完成项。
- [ ] **2.5** 磁盘重建后 TodoWrite 那步的工具卡也照常在(live 本就卡片+面板)。
- [ ] **2.6**(回归)子代理(agentId)的 todo 不显示在主面板。

关联:`project_goal_rehydrate_on_load`。

## 3. 中文路径下 GenerateImage 回显图 / 路径链接(commit `ef511cba`,未 push)

修「中文路径下抠路径正则用 ASCII `\w` 断在中文段 → 残缺路径 → 图打不开」。前置:在中文路径项目(如 `mimi-test-videos`)。

- [ ] **3.1** 让 AI 调 GenerateImage 生成一张图 → 聊天里直接显示缩略图(不是只有文件名链接、不是空白)。
- [ ] **3.2** 点缩略图 → Lightbox 大图正常。
- [ ] **3.3** 点文件名 → Files 面板定位文件;⌘/Ctrl-点 → 系统默认应用打开。
- [ ] **3.4** AI 在回答正文写一个中文文件名路径(如 `outputs/ep01/assets/img/ep01-char-萧炎.png`)→ 渲染成可点链接,点开能定位。
- [ ] **3.5** 回答正文写一个中文目录段的路径 → 同样可点。
- [ ] **3.6**(回归)纯英文路径的图/链接照常工作。
- [ ] **3.7**(回归)正文里 `obj.method` / `v1.2` / `example.com/x.html` 没被误判成链接。

关联:`project_cjk_path_regex_w_bug`。

## 4. Steer 排队 / 引导改造(main `4d2c9e28` / feature `3d48a9e8`,未 push)

把「排队/引导」语义整体纠正,涉及 core→protocol→preload→renderer 五层 + 新 RPC `agent/unsteer`。找一个会跑多步(多次工具调用)的长任务当测试床,否则没有"步间隙"可观察。

### 4A. 排队 = 不打断、步间插入
- [ ] **4A.1 排队可见**:发会跑多步的长任务 → busy 中打字按 Enter → 进「后续变更」排队面板并停留可见(不一闪就没)。
- [ ] **4A.2 步间插入**:当前步结束进下一步 → 排队那条自动消失变成对话流里的 user 气泡;AI 下一步确实看到了。
- [ ] **4A.3 不打断**:4A.2 时当前轮没被 abort(没有「你在 Ns 后停止了」标记,进行中那步没丢)。
- [ ] **4A.4 多条排队**:连续 Enter 两三条 → 都进面板 → 各自在后续步边界依次插入变气泡(每条只插一次,不重复)。
- [ ] **4A.5 cachedHint 文案**:若出现「已排队 N 条,将在下一步插入当前轮」提示,文案正确(不是旧的「本轮结束后发送」)。
- [ ] **4A.6 末步排队不双气泡(回归 `12bcdde2`)**:在当前轮**快结束/最后一步**时 Enter 排一条(它已被 auto-steer)→ 挂着让这一轮**自然跑完**(不打断)→ 这句**只出现一条** user 气泡。真因曾是:turn-loop 只在 step 顶部 consumeSteer,末步结束没消费 → 残留在引擎队列;busy→false 后 dequeue 又 send 一遍成新 run → 新 run 再消费残留 → 双写。修=dequeue 重发前先 unsteer 已 steer 的条目。**用户实测命中过(无 cancel 的那条),重点验。**

### 4B. 两个「引导」按钮 = 强行打断
- [ ] **4B.1 输入框「引导」**:busy 中打字 → 点输入框右侧「引导」→ 立刻打断当前轮(abort)并作为新一轮重发;出现停止标记 + 新 user 气泡。
- [ ] **4B.2 排队区「全部引导」**:busy 中排队 ≥1 条 → 点「全部引导」→ 立刻打断,把排队全部合并成一条重发。
- [ ] **4B.3 tooltip 名实相符**:两个按钮 hover tooltip 都说「打断当前轮…」且行为确实是打断。
- [ ] **4B.4 打断不双气泡(回归 `7db26bd4`)**:busy 中 Enter 排一条(已自动 steer)→ 立刻点引导/全部引导打断 → 这句**只出现一条** user 气泡(不是两条)。真因曾是:已 steer 的条目残留在引擎 steerQueueBySid,cancel 不清它,被 relay 重发的新 run 又消费一次 → 双写 transcript。修=relay 前先 unsteer 已 steer 的条目。**用户实测命中过,重点验。**

### 4C. 真撤回(unsteer RPC)
- [ ] **4C.1 撤回未消费**:Enter 排一条 → 趁它还在面板里点删除 → 从面板消失,且之后不会再变 user 气泡(引擎队列真删)。
- [ ] **4C.2 撤回来不及(静默)**:排一条后故意慢点删,若引擎已消费 → 删除点下去不报错,这条照常变气泡(removed=false 静默)。不卡死/不红错/不重复气泡。
- [ ] **4C.3 清空全部**:排多条 → 点「清除」→ 未消费全部撤回消失;已消费静默变气泡。
- [ ] **4C.4 撤回竞态**:排 3 条,删中间那条同时另一条正好插入 → 删对目标(按 id 不按下标),没误删。

### 4D. Resume / 持久化(回归,别打破改造前修过的双气泡)
- [ ] **4D.1 步间插入后 resume**:4A.2 让一条变气泡后刷新/重开 → 这条 user 气泡只出现一次(不双份)。
- [ ] **4D.2 打断轮 resume**:4B 打断后刷新 → 被打断那轮折叠/标记正常(「你在 Ns 后停止了」还在,没退化成普通折叠进度卡)。

### 4E. 边界 / 不回归
- [ ] **4E.1 idle 发送照常**:不 busy 时正常发 = 直接发。
- [ ] **4E.2 空闲排队**:idle 把内容排进队列(正常走 send),不卡不丢。
- [ ] **4E.3 多会话并发**:两会话同跑,在 A 排队 steer 只影响 A 不串到 B(按 engineSessionId 路由 + 按 bucket 移除)。
- [ ] **4E.4 子代理不受影响**:有后台子代理时主 run 的排队/插入正常(sub-agent sessionId 不暴露给 UI)。

> 已知取舍(非 bug):撤回已消费的拿不回来(steer 无反向消费语义),按 4C.2 静默留着;排队条目停留到引擎确认才消失,窗口长短取决于 AI 多久到下一步边界。
> 排查锚点:core `engine/steer-queue.ts`、`engine.ts` `enqueueSteer/unsteer/consumeSteer` + `turn-loop.ts` 步间消费点;renderer `App.tsx` `steeredIdsRef`/auto-send useEffect/`steer_injected→removeQueuedInputById`、`queuedInput.ts`。⚠️坑:preload `rpc()` resolve 整个 `{id,result}` 信封,unsteer 的 removed 在 `.result.removed` 不是 `.data`。
> 关联:`project_steer_inject_channel`。

## 5. Cookie 登录全链路 ✅ 真机已验(用户 2026-06-24,audit §1.3 的「唯一没真机验过的核心新功能」已消除)

- [x] **5.1** 开独立登录窗登 YouTube → 点「保存」→ 凭证页出现该账号。
- [x] **5.2** 切到另一账号(同域多账号)→ 让 AI `UseCredential`/`InjectCredential` 取用 → 浏览器面板以该账号身份可见登录态。
- [x] **5.3**(小红书路线)登录小红书 → 拓取 → 切换 → AI 取用全链路。
- [x] **5.4** 逐条「AI 可自动取用 / 自动注入」开关改动后需重启 app 才生效(新 preload/main IPC)——确认重启后生效。

> ✅ 全 4 项用户 2026-06-24 真机验过,无问题。

关联:`project_browser_login_window`、`project_multi_account_cookie_creds`。

## 6. no-repo cwd 漂移 + gpt5.5 effort(未 push)

> 注:原 merge `e4b99a52` 已在后续整理中解开(不在 HEAD 主线),但修复内容已在 HEAD——no-repo cwd 不传逻辑在 `settings/manager.ts`+`cli/agent-server-stdio.ts`,gpt5.5 `noEffortWithTools` capability 在 `llm/capabilities/rules.ts`(2026-06-25 核查)。

- [ ] **6.1** 无项目纯聊天(no-repo)下,长命 worker 不再兜到陈旧项目;skill 关闭状态正确、搜对目录。
- [ ] **6.2** gpt5.5 + 工具 + effort 不再每轮撞 400。

关联:`project_norepo_cwd_drift_and_gpt55_effort`。

---

## 其他单独追踪(不在 main 主线,各自文档)

- **Windows 移植** P1–P8:见 `docs/research/core-reading/windows-port-plan.md`(需在 Windows 真机跑)。`project_windows_port`。
- **删 legacy 模型存储**:在独立 worktree(13 commit 未合 main),desktop 冒烟 + 合并待办。`project_legacy_model_storage_removal`。
- **手机遥控 UI 重构**:需手机 + 桌面 Electron 扫码实测。`project_mobile_ui_react_rebuild`。

## 已验过(存档,无需再跑)
- 浏览器圈选回显双窗互通(2026-06-13 用户确认)。`project_browser_selection_echo_session`。
