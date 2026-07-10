# 浏览器面板地址栏复制地址与修饰键外部打开

## 1. 问题与现状

内置浏览器组件已定位为 `packages/desktop/src/renderer/panels/BrowserPanel.tsx`。它使用 Electron `<webview>` 和自绘地址栏，而不是 Chromium 原生 browser chrome：

- 地址栏位于 `BrowserPanel.tsx:219-246`，是受控 `<Input>`，值来自 `active.draft`；目前只处理输入变化与 Enter 导航，没有 `onContextMenu` 或 Cmd/Ctrl 点击处理。
- 当前页面 URL 的权威状态是 `active.url`。`packages/desktop/src/renderer/browser/useBrowserTabs.ts:176-180` 在 `did-navigate`/`did-navigate-in-page` 后同步 `url` 和 `draft`；`:255-275` 处理地址栏主动导航。
- 面板已经有独立的“在外部打开”图标按钮，位于 `BrowserPanel.tsx:315-320`；失败页也有相同动作（`:390-398`）。因此本项无需发明新的 openExternal 通道，只需补充地址栏和页内链接的快捷交互。
- preload 已在 `packages/desktop/src/preload/index.ts:691` 暴露 `window.codeshell.openExternal()`，声明在 `preload/types.d.ts:844`。main 的 `packages/desktop/src/main/index.ts:3251-3254` 接收 `shell:openExternal`，最终由 `desktop-services.ts:690-695` 拒绝非 `http(s):/file:` scheme 后调用 Electron `shell.openExternal()`。

页内链接存在一个与需求相反的现状：

- `useBrowserTabs.ts:76-92` 会向 guest 注入 capture click listener。
- 该脚本把 `target="_blank"`、Cmd/Ctrl 点击和中键点击都归为 `wantsNew`（`:87`），拦截后通过 console sentinel 传回 host。
- host 在 `:198-220` 一律调用 `openInNewTab(url)`，所以 Cmd/Ctrl 点击当前会打开内置 browser tab，而不是系统默认浏览器。
- 这段注入不是多余逻辑：Electron `<webview>` 对 `_blank` 链接存在事件缺失，main 的 `guest.setWindowOpenHandler` 只作为不完全兜底。相关说明与 handler 位于 `packages/desktop/src/main/index.ts:1286-1329`。实现修饰键行为时必须扩展这条 guest bridge，不能只改 main handler。

剪贴板也已有可复用能力：

- `packages/desktop/src/renderer/lib/clipboard.ts:14-55` 的 `copyText()` 优先调用 `navigator.clipboard.writeText()`，失败时回退隐藏 textarea + `execCommand("copy")`，并保证不抛未处理 rejection。
- main 在 `packages/desktop/src/main/index.ts:1452-1464` 只对应用自身 renderer origin 放行 `clipboard-sanitized-write`；browser guest 位于独立 partition，不会因此获得应用剪贴板能力。复制动作应在 host renderer 执行，不能注入 guest 执行。
- 已有通用右键菜单 `packages/desktop/src/renderer/ui/ContextMenu.tsx:5-79`，可直接复用其 viewport 边缘翻转、outside click 和 Escape 关闭逻辑。

## 2. 目标

- 在地址栏右键显示“复制地址”，一键复制当前已提交页面 URL，并给出成功/失败反馈。
- Cmd（macOS）或 Ctrl（Windows/Linux）点击地址栏时，用系统默认浏览器打开当前 URL，不触发内置导航。
- Cmd/Ctrl 点击 webview 页内的 http(s) 链接时也用系统默认浏览器打开；普通点击保持页内导航，`target=_blank` 和中键仍保持现有的“内置新标签”行为。
- 所有外部打开继续经过 main 的 scheme 校验；不新增 guest 权限，不把 `window.codeshell` 暴露给外部网页。
- 新标签页 sentinel `about:blank`、空地址及非 http(s) 页内链接不触发外部打开。

## 3. 详细修改方案

### 3.1 BrowserPanel：地址栏上下文菜单

修改 `packages/desktop/src/renderer/panels/BrowserPanel.tsx`：

- 导入现有 `ContextMenu`、`copyText` 和 toast hook。
- 增加局部状态：

  ```ts
  const [addressMenu, setAddressMenu] = useState<{ x: number; y: number } | null>(null);
  ```

- 在地址 `<Input>` 上增加 `onContextMenu`：`preventDefault()` 后记录 `clientX/clientY`。菜单至少包含：
  - “复制地址”：复制 `active.url`；
  - “在系统浏览器中打开”：复用 `window.codeshell.openExternal(active.url)`。
- 当前 URL 为 `NEW_TAB` 时禁用两项，不能复制内部 sentinel。这里明确复制 `active.url` 而非 `active.draft`：用户可能正在编辑但尚未按 Enter，“当前地址”应指 webview 已提交地址；若未来需要“复制输入内容”，应作为独立菜单项。
- `copyText()` 的 boolean 结果映射到 success/error toast。新增 `panels.browser.copyAddress`、`addressCopied`、`copyAddressFailed` 中英文 key。
- 菜单渲染在 BrowserPanel 根部并在 tab 切换、URL 变化或 panel unmount 时关闭，避免菜单动作落到已切换页面。

也可同时在现有外部打开按钮旁增加 copy icon 作为可发现性入口，但右键菜单是本 feature 的必需交互；两者应调用同一个 `copyCurrentAddress()` callback，避免反馈不一致。

### 3.2 BrowserPanel：Cmd/Ctrl 点击地址栏

在地址 `<Input>` 增加修饰键点击处理：

```ts
onClick={(event) => {
  if (!event.metaKey && !event.ctrlKey) return;
  if (!isExternalHttpUrl(active.url)) return;
  event.preventDefault();
  void window.codeshell.openExternal(active.url);
}}
```

注意事项：

- 建议抽取 renderer-local `isExternalHttpUrl()`，只接受解析后 protocol 为 `http:`/`https:`。地址栏虽然也可能显示 `about:`，但需求是用系统浏览器打开网页；不要把 `about:` 送到 main 后再靠异常控制流程。
- 普通点击仍应聚焦输入框，选择/编辑行为不能被破坏。
- 在 `onMouseDown` 中检测修饰键并 `preventDefault()` 可避免外部打开时地址栏光标位置变化；实际 open 调用保留在 click，以维持键盘/辅助技术的一致激活语义。
- 捕获 `openExternal()` rejection 并 toast，避免系统拒绝时静默失败。

### 3.3 useBrowserTabs：给 guest bridge 增加 disposition

修改 `packages/desktop/src/renderer/browser/useBrowserTabs.ts` 的注入协议。将当前“只传 URL”的 sentinel payload 扩成：

```ts
type GuestLinkDisposition = "internal-tab" | "external";
interface GuestLinkRequest {
  url: string;
  disposition: GuestLinkDisposition;
}
```

guest 脚本的分类规则：

- `e.metaKey || e.ctrlKey` → `external`；
- `a.target === "_blank" || e.button === 1` → `internal-tab`；
- 其余普通点击不拦截，交还 guest 原生导航。

只有 http(s) anchor、trusted click 才发送消息。命中上述两类时继续 `preventDefault()` + `stopPropagation()`，避免同一次手势既打开系统浏览器又触发 guest 导航。

把 `parseOpenTabConsoleMessage()` 重命名为更准确的 `parseGuestLinkConsoleMessage()`，返回经过 URL 解析的 `{ url, disposition }`，并继续执行现有安全条件：

- sentinel 必须出现在 message 开头；
- nonce 必须匹配本 panel 注入值；
- URL 必须是绝对 http(s)，解析后 protocol 再检查一次；
- disposition 必须在白名单内，未知/旧伪造值拒绝。

host `onConsole` 根据 disposition 分流：

- `external`：调用 `window.codeshell.openExternal(url)`；
- `internal-tab`：调用现有 `openInNewTab(url)`。

现有 `shouldAcceptOpenTabConsoleUrl()` 的去重/限流（`:52-73`）需要扩成按 `disposition + url` 建 key。否则用户先 Cmd 点击外部打开、紧接着用中键内置打开同一 URL，会被误判为重复；同时仍防止恶意页面短时间刷大量 console sentinel。

### 3.4 Main / preload / webview 权限

本 feature 不需要新增 IPC 或 Electron 权限：

- 外部打开继续走 `shell:openExternal`，保留 `desktop-services.ts:690-695` 的 scheme allowlist。
- 复制发生在 CodeShell host renderer，复用现有 clipboard permission handler；不要给 `persist:browser:*` guest partition 配 clipboard 权限。
- `guest.setWindowOpenHandler` 仍处理脚本 `window.open()` 和注入桥未覆盖的情况，并继续返回 `{ action: "deny" }`，不创建原生 popup。
- main handler无法稳定拿到 link click 的 Cmd/Ctrl modifier，因此不在 main 猜测 disposition；可靠语义以 trusted guest click bridge 为准。

### 3.5 国际化和可访问性

修改 `packages/desktop/src/renderer/i18n/ns/panels.ts` 的中英文 browser namespace：

- `copyAddress`
- `addressCopied`
- `copyAddressFailed`
- 可选 `openAddressExternally`

ContextMenu 已带 `role="menu"/"menuitem"`。若增加 copy icon，必须有本地化 `aria-label/title`。修饰键点击是增强路径，原有外部打开按钮继续作为键盘与触屏可达入口。

## 4. 分步骤实施顺序

1. 先重构 guest sentinel payload/parser，使其能区分 `internal-tab` 与 `external`，保留原有 `_blank`/中键行为。
2. 更新 `useBrowserTabs` console handler，将 external disposition 接到现有 preload API，并补纯函数/注入脚本测试。
3. 在 BrowserPanel 抽取 `copyCurrentAddress()` 与 `openCurrentExternally()` 两个 callback。
4. 接入地址栏 ContextMenu 和成功/失败 toast，再补 Cmd/Ctrl click handler。
5. 添加 i18n key 与组件测试。
6. 最后人工验证 main window、browser popout（同样复用 BrowserPanel）和各平台修饰键。

## 5. 测试策略

### 单元测试

- 扩展 `packages/desktop/src/renderer/browser/useBrowserTabs.test.ts`：
  - parser 接受带正确 nonce 的两种 disposition；
  - 拒绝未知 disposition、错误 nonce、非 http(s)、伪造前缀和畸形 JSON；
  - 注入脚本对 Cmd/Ctrl 产生 `external`；
  - `_blank` 和中键产生 `internal-tab`；
  - 普通同页点击不拦截、不发 sentinel；
  - synthetic click 仍被拒绝；
  - 去重 key 包含 disposition，且总体速率上限仍生效。
- 新增 BrowserPanel 组件测试（mock `window.codeshell`）：
  - 地址右键打开菜单，复制的是 `active.url` 而不是未提交 draft；
  - NEW_TAB 时菜单项 disabled；
  - `copyText` 成功/失败显示对应 toast；
  - metaKey/ctrlKey 点击调用一次 openExternal，普通点击不调用；
  - openExternal reject 被处理，不产生 unhandled rejection。

### 集成/手工验证

- macOS：Cmd+点击地址栏、页内普通链接、`target=_blank` 链接；Windows/Linux 对应 Ctrl。
- 确认 Cmd/Ctrl 页内点击只打开系统浏览器，内置 tab 数不增加，原页面不跳转。
- 确认 `_blank` 普通点击和中键仍打开内置新 tab，避免回归 `electron/electron#30886` 绕过逻辑。
- 重定向/SPA 页面上右键地址栏，复制结果应等于 webview 最新 committed URL。
- dev（localhost renderer origin）和 packaged（file origin）分别验证 clipboard；复制失败时出现错误反馈。
- browser popout 中重复上述动作，确认 ContextMenu 未被窗口边缘裁切。

## 6. 风险与兼容性注意

- **不要删除 guest 注入桥**：main 的 window-open handler 对 `<webview>` `_blank` 点击并不可靠；只在现有协议上增加 disposition。
- **不要复制 draft**：未提交输入可能只是半个 URL 或搜索词。复制 `active.url` 才符合“当前地址”。
- **scheme 防护要双层保留**：renderer 只发 http(s)，main 仍保留最终 allowlist，防止未来其他调用者绕过。
- **页面 console 不可信**：外部网页可以输出任意日志；nonce、结构、URL、disposition 校验和限流不能因 payload 扩展而弱化。
- **事件重复**：某些站点同时使用 anchor click 与 `window.open()`。现有 URL 去重窗口用于压制重复；扩展 key 时要保证同 disposition 的重复仍会被压制。
- **触屏可达性**：手机/触控板没有稳定右键或修饰键，因此保留现有 ExternalLink 按钮；若增加 copy icon，更有利于无右键设备。
- **剪贴板权限边界**：复制必须由 host renderer 执行。不要向外部 guest 注入 `navigator.clipboard` 调用或放宽 browser partition 权限。
