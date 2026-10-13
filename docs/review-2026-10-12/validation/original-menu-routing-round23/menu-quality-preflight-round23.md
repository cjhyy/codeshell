# 第23轮：macOS 全局菜单窗口归属的独立只读预审

结论：**支持保留一个独立、范围窄的 P3 候选；本审 Completed，新增执行0。** 本审没有运行 native/Electron、浏览器、fixture、测试、Core/worker、模型或网络；没有修改产品/作者fixture/主报告。这里是对可达生产源码与本地 Electron 契约的独立核对，尚非原生菜单点击实测。未给正式编号，R01–R81及通用81/243计数不变。

审查基线是冻结 latest a66f4ef2；先前已读 CODESHELL.md 和当前主报告/flow，本轮补读整个 menu.ts、全仓 menu/focus/closed 接线、实际 preload/App 消费和本地 Electron 33.4.11 类型文档。未将“两个基线源码相同”当成双基线执行收据。

## 根因与可达时序

`installAppMenu(win)` 在 macOS 构建并调用全局 `Menu.setApplicationMenu(menu)`，但自定义 `click` 完全忽略点击时的 window 参数，闭包直接 `win.webContents.send(...)`。见 [menu.ts:11](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:11)、[menu.ts:43](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:43)、[menu.ts:144](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:144)。本地 Electron 文档说明 macOS 此 API 设置应用菜单，且 constructor click 提供 window 参数，见 [electron.d.ts:8658](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/node_modules/electron/electron.d.ts:8658)、[electron.d.ts:19976](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/node_modules/electron/electron.d.ts:19976)。这证明窗口参数可供路由；不能把本地类型声明写成已经操作真实 macOS 菜单。

全仓搜索到唯一生产安装调用是 `createWindow` 最后 [Main index.ts:2711](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:2711)。`refreshAppMenu` 只有定义和内部调用 install，没有生产调用者；没有 browser-window-focus、主窗口 focus 或 closed 分支重装应用菜单。窗口 closed 的实际清理见 [index.ts:1541](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1541)。因此准确说法是**最后完成菜单安装的窗口**持有这些闭包，不能把并行 create 时的异步安装顺序直接写成固定“最后创建”。

可达操作不需要人为暂停、错误 transport 或同项目共享状态：

1. 正常创建A，等待其菜单安装完成。
2. 使用正式“新窗口”创建B并等待安装完成。菜单的 `menu:new-window→preload→App.newWindow→window:new→createWindow` 和 CommandPalette入口均存在，见 [menu.ts:43](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:43)、[App.tsx:1462](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1462)、[index.ts:5835](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5835)、[CommandPalette.tsx:189](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/shell/CommandPalette.tsx:189)。
3. 用户重新聚焦A，并从macOS应用菜单**显式点击**查找/命令面板/切换侧栏或最近项目。回调仍向B发消息，A的聚焦不会改变捕获的win。
4. 若B已关闭而A仍在，闭包仍指向B，未检查win/webContents是否destroyed或选择存活主窗口。源码支持“向已销毁目标发送”的路径；实际 throw/error呈现、菜单启用策略及OS回调是否执行尚未动态测量，**不据此宣称Main崩溃、应用无法退出或数据丢失**。

## 实际用户影响与收窄

| 显式菜单项 | 实际接线与可证明的静态结果 |
| --- | --- |
| 查找、命令面板、侧栏 | [menu.ts:85](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:85)、[menu.ts:97](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:97)、[menu.ts:104](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:104) 发B；[preload:1423](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1423) 只在收到消息的renderer监听并分发；[App:1450](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1450) 修改本renderer的 search/palette/sidebar。相应state初始化于 [App:221](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:221)。A前台未得到所请求的界面，B后台发生界面变化。 |
| 最近项目 | [menu.ts:61](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:61) 发B，实际 [App:1429](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1429) 在B设置activeProjectId，必要时先读取registry。activeProjectId是窗口useState（[App:218](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:218)）。因此即使A/B查看不同项目，也有独立的错误目标导航路径。 |
| 添加项目 | [menu.ts:50](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:50) 让B执行handleAddProject；[useSessionNavigation:120](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:120) 成功选择后在调用窗口设置activeProjectId。picker的实际OS焦点/模态呈现未验证，不夸成确定“对话框只显示在B”。 |

排除/限定：

- “切换详情”在 [App:1459](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1459) 明确no-op，不拿已移除能力当新的窗口故障。
- Close、Undo、Reload、Zoom、Fullscreen等为Electron role，未使用这组capturedwin自定义消息，不扩大成所有原生菜单都错误。
- 两个存活窗口时，“新窗口”的接收者无论A/B最后都调用同一Main createWindow，单凭发B不能证明新窗口创建结果错误；它只作为合法多窗触发入口。B关闭后的新窗口菜单是否失效仍属尚待原生验证的dead-target范围。
- 仅macOS安装此菜单；非darwin分支直接setApplicationMenu(null)，不声称Windows/Linux同样受影响。
- 自定义菜单有accelerator，但与renderer keydown的处理优先级、是否同时触发或被OS消费没有实测。因此候选触发限定**显式菜单点击**，不宣称快捷键必然异常或一定可作恢复。
- 未发现输入发送/文件写入/会话删除的菜单路径；没有证明草稿、消息、会话历史损失、跨会话执行或权限越界。

## 正常控制、恢复及P3建议

静态正常对照：单一存活A且菜单最后安装给A时，闭包目标正确；菜单最后安装给B且B前台时也正确。捕获目标存活并且实际期望目标就是该窗口时，不会触发该候选。

可见替代入口不是全局菜单恢复：A自己的TopBar sidebar按钮直接调用其onToggleSidebar（[TopBar:120](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/TopBar.tsx:120)）；A自己的Sidebar添加项目/选择项目/搜索行直接调用自己的props（[Sidebar:386](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:386)、[Sidebar:411](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:411)、[App:2193](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2193)）。Sidebar搜索打开的是SessionSearchModal，不冒充同一个全文SearchView入口。关闭误开的B面板/在B重选原项目可以纠正其导航，但不是修复全局菜单路由。

聚焦/重载A本身没有重新安装Main菜单的接线，不能写成自动恢复。重新创建C完成菜单安装并在C操作可使菜单重新指向存活窗口；macOS关闭全部主窗口后activate的 [index.ts:7206](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:7206) 也会createWindow并重装，但这是静态生命周期恢复，不是本轮实测。macOS window-all-closed不直接quit（[index.ts:7133](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:7133)），所以关闭捕获窗口而应用仍在的前提自然可达。

建议P3：正式支持的普通多窗操作存在清楚的错误窗口投递；主要后果是前台操作不生效、后台导航/UI变化和关窗后菜单目标过期，已有窗口内替代入口，未证明重要任务阻断或不可逆损失。尚无native动态receipt，不建议升P2或描述为安全问题。若后续动态验证，优先只读Find/Sidebar/Recent和dead-target，不需真实模型、用户项目或账户。

## 与R61去重与修复位置

R61/M1的路径是同项目S1/S2普通选择写共享catalog，再广播把另一窗口的activeSessionId覆盖；需要分离窗口active selection与共享持久目录。本候选在Main菜单发送阶段已选错renderer；无需同项目、catalog更新、异步late response或session切换，Find/Sidebar就能触发。两者触发条件和修复点独立，不能因都涉及多窗而合并。

修复方向应在自定义菜单click时选择当前合法、存活的主窗口并明确定义无主窗口行为，不能只长期捕获安装时win。可参考同仓已存在的 [preferredMainWindow:2995](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:2995) 的存活/主窗口筛选，但不能把Browser/Widget等任意BaseWindow直接当主renderer。菜单重建因loadRecents是async，只靠focus时重装还需处理安装顺序；本审不实施修复。

Completed，新增执行0。此预审没有确认真实OS呈现/accelerator竞争/销毁对象异常的原生结果；支持仅据确定性生产路由保留窄P3候选，正式纳入由root决定。
