# 网页端 ↔ 桌面端体验对齐审计（2026-11-19）

范围：浏览器访问的 Web 工作台（`packages/web/app/*`，含 Server 直连与经账号中继
`codeshell.site` / `*.devices.codeshell.site` 打开的同一 SPA），对照 Electron
桌面渲染层（`packages/desktop/src/renderer/**`）。基线：`origin/main` 71ffe8702。

约束：只改客户端；不改协议、不改服务端（`codeshell-services` 不动）。

## 结论摘要

- 主题色值、会话按项目分组、复制按钮、排队/停止/模型选择、提问卡倒计时/跳过/一直等，
  网页与桌面已一致。
- 差距集中在：手机视口安全区、输入法回车、附件粘贴/拖放、提问卡键盘操作、
  文件编辑卡片可读性、断线后手动重连。本次修复 8 项。
- 网页**不能**直接 import 桌面渲染层组件：依赖方向是 desktop → web（反向成环），
  ESLint `crossWorkspaceRelative` 禁止跨包相对导入，桌面组件依赖 Tailwind/`@/components/ui`
  与 `window.codeshell`。要共享 UI 只能下沉到 `packages/web/src` 再由桌面复用。
  因此本次"复用桌面"指复用桌面的**行为与文案约定**（`- old`/`+ new` 标签、
  IME 判定条件、Enter/Shift+Enter 语义），实现留在 web 包内的独立小模块，
  不复制桌面组件代码。

## 差异表

| #   | 项目                   | 桌面行为                                                                                                   | 网页现状（修复前）                                                                                                            | 本次是否修复                                                                                        |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | 手机视口/安全区        | 桌面自带手机页 `desktop/src/mobile/index.html` 设 `viewport-fit=cover, interactive-widget=resizes-content` | `web/app/index.html` 无 `viewport-fit=cover`，iOS 上 `app.css` 里所有 `env(safe-area-inset-*)` 恒为 0；`theme-color` 固定深色 | ✅ 修复：视口加 `viewport-fit=cover, interactive-widget=resizes-content`；`theme-color` 分浅/深两条 |
| 2   | 输入框 IME 回车        | `ChatView.tsx` 用 composition 状态 + `isComposing` 双重判定                                                | 只看 `nativeEvent.isComposing`；Safari 中文输入确认时 `isComposing=false, keyCode=229`，会误发送                              | ✅ 修复：`composer-input.tsx` 的 `isImeComposing` 同时判 `isComposing` 与 `keyCode===229`           |
| 3   | 粘贴附件               | `ChatView.tsx` 粘贴图片/文件直接成为附件                                                                   | 无 `onPaste`，只能点按钮选文件                                                                                                | ✅ 修复：粘贴含文件时走与附件按钮相同的 `addFiles`；纯文本粘贴不受影响                              |
| 4   | 拖放附件               | 拖文件到输入区成为附件，有高亮                                                                             | 无                                                                                                                            | ✅ 修复：输入区支持 dragenter/over/leave/drop，拖入时虚线高亮                                       |
| 5   | 提问卡键盘             | `AskUserMessageView.tsx` Enter 提交、Shift+Enter 换行、带 IME 守卫                                         | 自定义回答只能点"回答"                                                                                                        | ✅ 修复：宽屏 Enter 提交、Shift+Enter 换行、IME 不提交；手机保持 Enter 换行（与网页输入框一致）     |
| 6   | Edit/Write 工具卡      | `FileToolCard.tsx` 显示 `- old` / `+ new` / `content` 分块                                                 | 参数整体 `JSON.stringify`，换行被转义，不可读                                                                                 | ✅ 修复：`toolFileBlocks.ts` 投影 Edit/MultiEdit/Write，删改着色，其余参数仍以 JSON 显示            |
| 7   | 手机输入框缩放         | Electron 不涉及                                                                                            | ≤760px 下搜索框/标题框 14px，iOS 聚焦会自动放大页面                                                                           | ✅ 修复：≤760px 下 input/select/textarea 至少 16px                                                  |
| 8   | 断线提示               | 本地进程，基本不涉及                                                                                       | Server 直连断线只显示"已断开，重连中…"，退避最长需等待，无手动入口                                                            | ✅ 修复（Server 直连）：`ProtocolClient.retryNow()` + 横幅"立即重连"按钮；中继路径见未修项          |
| 9   | 会话搜索/快捷键        | 侧栏搜索 + ⌘P/⌘K/⌘1-9/⌘B                                                                                   | 只有"历史"页有搜索，无快捷键                                                                                                  | ❌ 未修（需新建全局快捷键层）                                                                       |
| 10  | 会话置顶/删除          | 右键菜单置顶/归档/删除                                                                                     | 历史页可重命名/归档，无置顶/删除                                                                                              | ❌ 未修（删除需确认协议是否支持）                                                                   |
| 11  | 代码高亮               | `react-markdown + rehype-highlight` + hljs 配色                                                            | 无语法高亮                                                                                                                    | ❌ 未修（需新增 `rehype-highlight` 依赖并核对包体积/lockfile）                                      |
| 12  | 斜杠命令/@ 提及/↑ 历史 | `ChatView.tsx` 支持                                                                                        | 无                                                                                                                            | ❌ 未修（需要命令目录查询，工作量大）                                                               |
| 13  | 待确认审批的定位       | 审批滚出视口时输入框上方有紧凑条，可跳回                                                                   | 审批卡在 transcript 末尾，滚上去后无提示（仅其它页面有横幅）                                                                  | ❌ 未修（下一批，IntersectionObserver + 跳转按钮）                                                  |
| 14  | 中继断线手动重连       | —                                                                                                          | `useRemoteSocket` 的 `reconnectNow` 只在 effect 内部，未暴露给工作台                                                          | ❌ 未修（需经 `useRemoteApp`（3500 行上限附近）暴露）                                               |
| 15  | 面板区                 | 侧边停靠 + 标签条（Files/Terminal/Browser/Review）                                                         | 面板以整页打开                                                                                                                | ❌ 未修（结构性差异，单独设计）                                                                     |
| 16  | 设置                   | 设置页带搜索、外观、快捷键等多个分区                                                                       | 4 个分区，无外观/主题                                                                                                         | ❌ 未修                                                                                             |
| 17  | 手动深浅色切换         | `theme.ts` `.dark` 类，可手动选                                                                            | 只跟随系统 `prefers-color-scheme`                                                                                             | ❌ 未修（色值已一致）                                                                               |
| 18  | 草稿持久化             | 按会话保存                                                                                                 | 仅内存，离页提醒（`drafts.ts` 有意设计）                                                                                      | — 设计差异，不改                                                                                    |
| 19  | 加载态                 | 骨架                                                                                                       | `SessionLoadingState`                                                                                                         | 一致                                                                                                |
| 20  | 中继会话过期           | —                                                                                                          | 4401/4403/4407 → 续期账号或重新配对/授权提示                                                                                  | 一致（已有）                                                                                        |
| 21  | 主题色值/字体          | `tailwind.css` zinc/暖橙                                                                                   | `app.css` 已逐值对齐；系统字体与 `ui-monospace`                                                                               | 一致                                                                                                |
| 22  | 宽表格/代码块          | 横向滚动                                                                                                   | 横向滚动                                                                                                                      | 一致                                                                                                |

## 本次改动文件

- `packages/web/app/index.html` — 视口与 theme-color
- `packages/web/app/composer-input.tsx`（新）— IME 判定、Enter 语义、粘贴/拖放 hook、连接横幅
- `packages/web/app/Workbench.tsx` — 接入上述模块（文件仍在 2000 行上限内）
- `packages/web/app/HubApprovalCard.tsx` — 自定义回答 Enter 提交
- `packages/web/app/toolFileBlocks.ts`（新）+ `MessageContent.tsx` — Edit/Write 分块
- `packages/web/app/protocol.ts` / `useHubController.tsx` / `workbench-types.ts` — `retryNow` 与 `retryConnection`
- `packages/web/app/app.css` / `message-content.css` — 拖放高亮、删改着色、手机 16px

## 测试

- `packages/web/app/composer-input.test.tsx`（新）— IME/Enter/文件判定/横幅/index.html 视口
- `packages/web/app/toolFileBlocks.test.ts`（新）
- `packages/web/app/protocol.test.ts` — `retryNow` 两例
- `packages/web/scripts/test-composer-parity-browser.mjs`（新，已登记 `ci.yml` desktop-ui 分片与
  `packages/web/package.json` `test:composer-parity-browser`）— 真 Workbench + 模拟 Host：
  提问卡 Enter 提交、粘贴附件、拖放附件、IME 回车不发送、普通 Enter 带附件发送、
  手机宽度输入框 ≥16px。设置 `CODESHELL_PARITY_SCREENSHOT_DIR` 时输出桌面 1280 与手机 390 截图。

截图目录：`docs/todo/web-desktop-parity-20261119/`（运行上面的脚本并设置该环境变量生成）。
