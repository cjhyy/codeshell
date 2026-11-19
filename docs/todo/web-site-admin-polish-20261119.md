# 官网 / 管理后台 / Web 工作台体验打磨（2026-11-19）

叠加在 PR #393（`feat/web-desktop-parity`，审计见
[`web-desktop-parity-20261119.md`](web-desktop-parity-20261119.md)）之上。范围是浏览器访问的三个面：

1. 官网与登录/注册/引导（`WebsiteHome` / `WebsiteLogin` / `WebsiteDestinations` / `ProjectsGate`）
2. 管理后台 `/admin`（`AdminConsole` + `WebsiteShell` 的管理导航）
3. Web 工作台 `/app`（Server 直连与账号中继共用的 `Workbench`）

对照：Electron 桌面渲染层（`packages/desktop/src/renderer`：`theme.ts`、`tailwind.css` 的
`--cs-primary`、侧栏搜索/置顶、`ChatView` 的待确认提示）。约束：只改客户端，不改协议与服务端，
不新增 npm 依赖。

截图位于 [`web-site-admin-polish-20261119/`](web-site-admin-polish-20261119/)，由下列浏览器冒烟
在模拟后端上生成（`before-*` 为基线 7686609c1，`after-*` 为本分支）。

## 审计

| #   | 面       | 现象（修复前）                                                                                      | 桌面行为                                                   | 处理       |
| --- | -------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------- |
| 1   | 工作台   | 侧栏"最近对话"只能滚动查找，无搜索                                                                  | 侧栏顶部有对话搜索                                         | ✅ 修复    |
| 2   | 工作台   | 无置顶                                                                                              | 右键菜单置顶，置顶组在最上                                 | ✅ 修复    |
| 3   | 工作台   | 审批/提问卡在消息末尾，滚上去后无任何提示，只能靠输入框旁"等待你的确认"                            | 输入框上方紧凑条，可跳回                                   | ✅ 修复    |
| 4   | 工作台   | 中继（账号/配对）断线只能等退避重试；`useRemoteSocket.reconnectNow` 是 effect 内部函数               | —                                                          | ✅ 修复    |
| 5   | 三个面   | 只跟随 `prefers-color-scheme`，无法手动选深/浅色                                                    | 外观设置：跟随系统 / 浅色 / 深色                           | ✅ 修复    |
| 6   | 官网/后台 | `.website-button.primary` 为近黑色，而登录按钮与桌面主按钮都是暖橙 `--cs-primary`                   | 主按钮统一暖橙                                             | ✅ 修复    |
| 7   | 官网     | "管理 Passkey"等正文链接是浏览器默认蓝色下划线                                                      | 链接用强调色                                               | ✅ 修复    |
| 8   | 后台     | 390px 下账号表格需左右滑动，状态与"停用/退出会话"在屏幕外，并靠一行"左右滑动表格"提示               | —                                                          | ✅ 修复    |
| 9   | 后台     | 操作记录的"操作人"只显示 UUID，管理员认不出自己                                                     | —                                                          | ✅ 修复    |
| 10  | 三个面   | 输入框聚焦环 `outline-offset: 3px`，与输入框边框形成"双框"                                         | 输入框紧贴的 ring                                          | ✅ 修复    |
| 11  | 官网首页 | 系统/手动深色时首页仍是纸色（固定品牌设计，约 50 处硬编码色值）                                     | —                                                          | ⚠️ 保持浅色，仅声明 `color-scheme: light` 让原生控件一致；深色首页需设计稿 |
| 12  | 后台     | 宽屏全页截图里侧栏只有一屏高                                                                         | —                                                          | 非问题：侧栏本就 `position: sticky`，是 fullPage 截图的伪影 |
| 13  | 工作台   | 代码高亮、斜杠命令/@/↑历史、停靠面板、设置分区（PR #393 审计 #11/#12/#15/#16）                       | 有                                                         | ❌ 未做，见"剩余差距" |

## 改动

- **会话搜索与置顶**（`app/SessionSidebarTools.tsx` + `session-sidebar-tools.css`，新）
  - 侧栏"工作区"下方加"搜索对话"，按标题/自定义标题/预览/ID 多词匹配，`Esc` 清空，无结果有明确提示；
    只过滤已加载的会话（不发新请求）。
  - 每行悬停/聚焦出现图钉；置顶对话进入"置顶"组并从下方列表移除。置顶按浏览器+工作区保存在
    `localStorage`（`codeshell.web.pinnedSessions:<workspaceKey>`），跨标签同步，损坏数据视为空。
    桌面的置顶同样是本地偏好，因此不需要协议改动。
  - 图钉的可访问名称不含会话标题（"置顶此对话"/"取消置顶此对话"），避免与行按钮的名称查询冲突。
  - `ProjectSessionNavigation` 增加 `filtered`，搜索/置顶后不再误报"还没有会话"。
- **待确认跳转条**（`app/ApprovalJumpBar.tsx` + `approval-jump-bar.css`，新）：审批卡外包一层
  `.approval-anchor`，用 `IntersectionObserver`（root 为消息列表）判断是否在视口内；滚出后输入框上方
  出现"N 项操作等待你确认 / N 个问题可稍后回答 · 查看"，点"查看"滚回并聚焦第一个可操作控件。
- **中继"立即重连"**：`useRemoteSocket` 暴露 `reconnectNow()`（跳过退避；在线时不拆健康连接；
  卸载后为空操作），经 `RemoteApp.reconnectNow` 传到 `DesktopApp`；控制器仅在 `status === "offline"`
  且无需重新授权时提供 `retryConnection`，于是工作台连接横幅与"正在连接桌面…"卡片都出现"立即重连"。
- **深浅色手动切换**（`app/theme.ts`、`ThemeToggle.tsx`、`theme-toggle.css`，新）：语义同桌面
  `theme.ts`（默认跟随系统）。`data-theme` 写在 `<html>`，`app.css` 的深色色板同时挂在
  `:root[data-theme="dark"]` 与 `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`；
  `theme-color` 随选择更新；`main.tsx` 与桌面手机页 `desktop/src/mobile/main.tsx` 首帧前应用。
  入口：工作台侧栏底部连接状态行、官网账号菜单（覆盖电脑选择页/账号设置/管理后台）、登录页页眉。
  面板 `prepare` 传的 `theme` 改为实际生效的主题。
- **主按钮强调色**（`website.css`）：`.website-button.primary` 改用 `--accent`/`--accent-text`，与登录
  按钮、桌面主按钮一致；官网/电脑选择/账号设置中无 class 的正文链接改用强调色下划线（品牌链接除外）。
- **后台手机卡片**（`AdminConsole.tsx` + `admin-console.css`）：≤760px 时每个账号渲染为卡片（角色/状态/
  会话三列、注册时间、底部两枚等宽操作按钮），删除"左右滑动"提示；表格补显式 `role`，因为改了
  `display` 后浏览器会丢失隐式表格语义。
- **操作记录**：当前管理员显示为"你（@用户名）"，悬停仍可看 ID。
- **聚焦环**（`app.css`）：`input/textarea/select` 的 `outline-offset` 改为 1px。
- **Workbench 行数**：`sessionStatusLabel` 与 `WorkbenchIcon` 移到 `app/workbench-icons.tsx`，
  `Workbench.tsx` 从 1994 行降到 1910 行（上限 2000），新 UI 都在独立文件。

## 测试

- 新单测：`app/theme.test.tsx`（偏好解析/持久化/存储异常/解析/`data-theme` 与 `theme-color`/CSS 与
  index.html 一致性/切换控件）、`app/SessionSidebarTools.test.tsx`（搜索、置顶顺序、存储隔离与容错、
  头部空态、跳转条文案）。
- 扩展单测：`src/hooks/useRemoteSocket.test.tsx`（`reconnectNow` 跳过退避、在线不重建、卸载后无效）、
  `app/DesktopApp.test.tsx`（仅离线且无需授权时提供"立即重连"）。
- 新浏览器冒烟 `scripts/test-workbench-polish-browser.mjs`（已登记 `ci.yml` desktop-ui 分片
  "test Web navigation…" 与 `package.json` `test:workbench-polish-browser`）：搜索/无结果/Esc、
  置顶并刷新后保留、审批卡滚出后出现跳转条并可跳回、深色持久化与 `theme-color`、跟随系统清除覆盖、
  手机搜索框 16px 与图钉 ≥32px。设置 `CODESHELL_POLISH_SCREENSHOT_DIR` 时输出截图。
- 扩展冒烟：`test-admin-console-browser.mjs`（主按钮=强调色、手机卡片控件不越界且列表无横向滚动、
  操作记录显示"你（@site-admin）"、账号菜单切深色）、`test-website-destinations-browser.mjs`
  （Passkey 链接=强调色）、`test-website-onboarding-browser.mjs`（登录页外观切换默认跟随系统）。

## 剩余差距

- 代码语法高亮（需 `rehype-highlight` 之类依赖，本次不加依赖）。
- 斜杠命令 / @ 提及 / ↑ 历史（需要命令目录查询）。
- 侧边停靠面板与标签条（结构性差异，需单独设计）。
- 设置页的外观/快捷键分区与全局快捷键（⌘K 等）；外观目前在侧栏与账号菜单。
- 会话搜索只覆盖已加载的会话；全文/服务端搜索仍在"历史对话"页。置顶不跨设备同步。
- 官网首页深色版本（需要设计稿）。
- 中继"立即重连"已有单测，未在真实账号中继上手测。
