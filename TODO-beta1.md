# TODO — Beta1 冲刺(2 天)

> 2026-06-17 整理:把原 `TODO.md` / `TODO-week.md` / `TODO-feedback.md` 收敛成这一份。
> 只保留**和 beta1 直接相关**的待办;大路线图压到底部一节(已归档,细节查 git log)。
> 动手前先 grep 现状 —— 大量「待办」项其实早已实现只差勾(见记忆 `project_todo_items_often_predone`)。
> 状态:🔴 必做 · 🟡 应做 · ⚪️ 延后(beta1 可签字接受)· ✅ 已完成

---

## 🎯 Beta1 关键路径(发布必经)

> 代码侧 review 全部确认 bug 已修(commit `997c9183`,**未 push**,领先 origin/main 13 个 commit)。
> core 1445 / desktop 881 测试、typecheck、renderer 构建全绿。剩下是验证 + 打包 + 发布。

- 🔴 **真机冒烟:弹窗登录抓 cookie 全链路** — 登 YouTube → 点保存 → 存进去 → 切换账号 → AI 取用。唯一没真机验过的核心新功能。若有问题趁没 push 在本地直接修。关联 `project_browser_login_window`。
- 🔴 **桌面 App 冒烟**(本机,发前必跑,清单见原 `docs/beta-smoke-checklist.md` A 节):装包→Gatekeeper 右键打开→主界面起来→子代理列表非空→市场有源→配 OpenAI 跑一轮→切模型→默认 agent 跑一次→生成一张图→关掉重开能恢复会话。
- 🔴 **全量打包构建**:`bun run build` + `cd packages/desktop && bun run dist`(electron-builder,未签名,`CSC_IDENTITY_AUTO_DISCOVERY=false`),确认 main 进程 / node-pty ABI / asarUnpack 没崩(老坑,见 `project_desktop_four_panels`)。
- 🔴 **`git push`** 这 13 个 commit 到 origin/main。
- 🟡 **npm 包**(若本轮要发):**必用 `bun publish --tag rc` 不是 `npm publish`**(workspace:* 解析);**发后必真跑一次 bin**(`code-shell --version`),别只看 publish 打印(rc.1 装得上跑不起来的教训)。
- 🟡 **i18n 全语言点一遍**:中/英切换走主流程,确认无未翻译泄漏 / 无 `localStorage` 报错(已修但真机再确认一次)。

### 验证速记(已通过,留档)
- ✅ core 1445 pass / desktop 881 pass · 两包 tsc 干净 · renderer build 成功
- ✅ 新增回归测试:YAML-delete / 域名 spoof / sanitizeUsername 控制字符(均验证修复前失败、后通过)

---

## ⚪️ beta1 延后(非 bug,记进 release notes 即可)

> 这些是 review 当时就标「conscious sign-off」的硬化项,不阻塞 beta1。

- ⚪️ **browser-login 硬化**(① 已修,核实 2026-06-25:已换 per-window `randomUUID()` nonce,哨兵必须带 nonce 全串,页面无法伪造):② `persist:login-*` 分区只清 cookie,localStorage/IndexedDB/SW 残留,与「用完即焚」文案有出入 → 改非持久分区或 `clearStorageData` 全清;③ BrowserHost phase-2(webview 收编)`kind:'webview'` 类型未预留、两套 will-navigate/open-handler 策略未抽共享 helper。关联 `project_browser_login_window`。
- ⚪️ **JSON-Schema 导出未接线**:`schema-export.ts` 无 caller(「wiring TBD」)→ 要么宿主启动写 `~/.code-shell/settings.schema.json` + settings.json 加 `$schema`,要么 release notes 注明不对用户暴露。关联 `project_desktop_i18n`。
- ⚪️ **i18n 收尾(增量)**:`"新对话"` 哨兵常量化;非 React helper(time.ts/streamGroups.ts)硬编码 localStorage key 应 import `KEY`;mobile(~149 处)单独接同套 i18n。
- ⚪️ **mac 签名/公证**:beta 未做正式签名 → 首次需右键打开(已在分发说明里告知)。
- 🟡 **Windows P8 真机冒烟**:代码 P1–P8 全实现 + CI `tests-windows` 绿,但无打包 job、无真机点验(起不了窗口/PTY/sandbox 降级)。beta1 若只发 mac 可整体延后。关联 `project_windows_port`。

---

## 📋 发后第一优先(beta1 之后立即排)

> 从原 TODO 里挑出最该先做、且不在 beta1 关键路径上的。

- 🔴 **记忆系统专项**(用户已拍板:先出整体设计再动手,别零敲碎打)— 第一批止血已做(96c5a3e:autoExtract 开关 + 批量清理 + redact + Dream 归档规则)。专项覆盖:生命周期状态机 / 完成态语义字段 / 自动提取确认流 / MEMORY.md 索引截断按需读 / 注入 token 预算。关联 `project_memory_and_dream_overview`、`reference_cc_codex_memory`。
- 🟡 **会话可靠性闭环**:长断网会话级重连(瞬时已被 withRetry 覆盖)、会话崩溃恢复产品闭环(disk 权威源恢复已做,缺崩溃后 UI 提示/一键恢复)、工具超时可取消性一致化、友好错误消息。
- ✅ **审查面板 turn 级范围**(原标真 bug)— 已实现:`ReviewPanel.tsx` 收到 `files` prop 时默认 `scope="turn"`,并用快照的 `turnDiff` 让 turn 范围在提交后仍可看。核实于 2026-06-25,留档。
- 🟡 **桌面面板 session 切换保活**:左侧切换 session 后再切回来,右侧面板 tab 元数据能恢复,但 BrowserPanel/webview 页面内容、面板内部状态会丢。根因是 App 只按 `activeBucket` 保存 `open/tabs/activeId`,未保存 per-panel 实例状态,session 切换会重建 PanelArea/PanelBody。后续做轻量版(保存 BrowserPanel 当前 URL 并恢复)或完整保活版(按 `activeBucket + tab.id` 缓存 panel 实例,配 LRU/idle eviction)。
- ✅ **手机端 CC 会话 UX 对齐桌面端**(全部完成,分支 `worktree-mobile-cc-session`,2026-06-26;待 push/合并):对普通用户去掉「房间/Room」概念,详情体验对齐桌面端(CC 会话列表 → 选权限模式 → CC 会话视图)。
  - ✅ 去房间外壳:删 `RoomList` 组件 + 用法 + 「打开房间」按钮 + rooms 抽屉;SidePane 固定为「会话 + CC 会话」两段;「房间」徽章→「CC」、「退出房间」→「退出会话」、文案/notice 去「房间」。hook 剪掉只服务房间列表的死导出(`refreshRooms/openRoom/createRoom/closeRoom/rooms/allRooms`),保留 `activeRoom`(解析 CC 会话标题/cwd)+ `leaveRoom` + room.message/history 传输层。
  - ✅ 进入前选权限模式:新增 `CcPermissionModeSheet` 底部弹窗(default/acceptEdits/bypassPermissions,全放行标红),点 CC session 先弹选择再 `openCcSession`,替换原硬编码 `"default"`;server `resolveRoomPermissionMode` 仍会收窄。
  - ✅ 补齐历史:`ccRoom.opened` 先拉 `ccRoom.readHistory` 作 backlog 再绑 live feed;新增 `ccHistoryToEvents` 映射 + `ccHistorySessionRef` 门控防 `room.history` replay 覆盖。
  - ✅ Markdown 渲染:新增手机版自包含 `Markdown.tsx`(react-markdown+remark-gfm+rehype-sanitize,无 IPC 依赖);完成态渲 Markdown、流式保持纯文本防抖。桌面 `CCConversationView` 仍是原始文本(留后,与手机不共享组件)。
  - ✅ loading 接线:新增 `loading.ccSessions`;`selectProject` 置 loading 并重置 `ccProbe/ccSessions`,`listSessions.ok` 清 loading,`App.tsx` 传给 `CcSessionList`。
  - ⚪️ 新建项目选择(低优,未做):点「新建」已能内联展开项目列表,只是没有显式「新建到项目…」标签;改文案即可。
  - 留档(勿重做):`CcSessionList` 按项目列外部 CC 会话且文案为「CC 会话」;审批卡片 + `respondCcApproval` 全链路;`MessageStream` loading 仅在空列表显示且切换 `reset` 清旧内容。
- 🟡 **真视频适配器**:替换 `FakeVideoProvider`,接 seedance/kling(待私有 API 文档)。框架 + 工具 + 后台轮询已就位,`getVideoProvider` 加 case 即可。

---

## 🗺️ 大路线图(beta1 不做,留存方向)

> 细节与历史完成项见 git log / 各特性 commit / 对应记忆。原三份 TODO 的 Roadmap 浓缩如下。

- **浏览器自动化 P4**(MVP 已实现:8 工具 + 独立 browser-driver + 观察遮蔽 + 安全):留后=交互审批弹窗 / 无人值守隐藏窗口 / 视觉兜底 SoM。
- **Cookie Lease**(`docs/browser-cookie-export-design-2026-06-14.md`):浏览器登录态→CLI 工具受控桥接(按域/按任务/一次性/审批 + 三层清理),覆盖 curl/yt-dlp/gallery-dl 等。整套未实现。
- **Workspace / Profile / 数字人**(`docs/workspace-profile-讨论稿.md` v0.5):base preset + 主指令 + 可移植经验三层 / 可切换 / Team Board。下一步 P3 seedance 手动落地。
- **Workspace 数据源绑定**(P4 roadmap):资源模型 / link 外部源(Figma/issue/云盘)/ scope 分配 / 工具 scope 检查。大子系统。
- **远程控制 / 跨代理编排**(P5 roadmap):SSH / 扫码配对 / 远控会话 / 编排 Codex+CC / 安全边界。大子系统。
- **手机遥控**(低优搁置):房间续跑(`--session-id`/`--resume`)+ 手机驱动真 codeshell session(走 core,复用 `outboundTaps`);现 mobile 无 Markdown 渲染。
- **聊天软件接入(channel,参考 OpenClaw)**:把微信/Telegram 等聊天软件做成可插拔 channel 前端,消息桥接进 codeshell 引擎。设计要点(参考 OpenClaw `docs.openclaw.ai/channels`):① **core 保持 channel-agnostic**,各平台接入做成外部插件(对齐 `project_core_minimal_harness_business_layer`),别塞 core;② 接入做成**一类凭证**进 CredentialStore(对齐 `project_multi_account_cookie_creds`)——微信走**扫码登录、token 存本地**(腾讯官方插件 `@tencent-weixin/openclaw-weixin`),Telegram 走 bot token;③ **扫码的那个微信号被绑死成该 channel 的收发身份**(机器人身份固定;换号要重扫;一般用小号),谁发都触发 → 必配 **allowlist** 白名单 + 绑定目标 agent;④ 微信当前只支持私聊 + 媒体,**不支持群聊**。未立项,先记方向。
- **工程质量 P7**:builtin tools 集成测试(已补 65 例)/ E2E / CI 覆盖率 >60% / 性能(启动懒加载、流式重渲染、大文件、MCP 连接池)/ 文档(用户指南/开发者文档/TypeDoc/中文文档)。
  - **Electron e2e 设施(从零加,playwright 现是孤儿依赖)**:`playwright` 已在 `packages/desktop` 但无 config / 无脚本 / 无任何 e2e 代码。用 Playwright 的 `_electron` API 驱动真机 app(起 `electron .` → 抓窗 → 点击/截图/断言),沉淀成可复用的 `verifier-electron` 基座(以后任何 UI 改动都能真机验,补当前靠人肉点验的缺口)。最小落地:① `playwright.config.ts` + `e2e/` 目录 ② `launchApp()` helper **按 title/URL 抓主窗——别用 `firstWindow()`(会抓到 DevTools 窗,已知坑)** ③ 第一个用例顺便验浏览器面板(开面板→新建 tab→输 URL→断言地址栏/标题更新)④ `package.json` 加 `test:e2e`。三个难点:抓错窗(对策见②)/ webview 嵌套需 `frameLocator` 钻进 guest(主窗 DOM 断言优先,少碰 webview 内部)/ native 依赖 node-pty 按 Electron ABI 重编 + CI 需 `xvfb-run`。约半天。关联 `project_desktop_four_panels`。
- **Markdown 渲染一致性**(desktop/TUI):标题/列表/引用/代码块/表格系统性梳理。
- **view_image TUI inline**(iTerm/kitty graphics protocol)+ 历史图降级文字摘要省 token。
- **设置/命名清理**:settings/repo/workspace 命名混杂收口;ModelSection 1065 行深度重排(绑 catalog 信息架构)。

### 明确不做(已决策,留因)
- **每轮主动请求压缩 / token 预算动态调档**:与 Anthropic prompt cache(前缀匹配)冲突,「压得狠而稀」才对缓存友好,固定 ratio 门控刻意保留。
- **Agent 角色 settings-level 默认**:硬编码 general-purpose 兜底已够,个人场景无实用价值。
- **路径授权审计日志**(B2):个人本地场景性价比低,降级暂缓;机制本身(越界/敏感拦截)是核心安全闸一直生效。
- **Git Bash 探测**(Windows):真实部署是 Docker/Linux,对它零价值;要做应作为 host 注入策略独立立项。
