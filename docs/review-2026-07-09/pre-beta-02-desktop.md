# Pre-beta 全 repo 体检 · 02 desktop

> 范围：packages/desktop/src（main / preload / renderer）。codex 独立只读会话，主编排代为落盘。基线 HEAD `ccef4283`。

## 结论：HOLD

Blocker 0 · Major 5。修完 Major 再发 public beta。

## Major

### M1 images:readDataUrl 允许 renderer 读任意绝对图片路径（安全，确证）
- 证据：`preload/index.ts:678` 暴露 `readImageDataUrl(absPath)`；`main/index.ts:2142-2150` 只校验 absolute/扩展名/lstat/大小后 `readFile`，无 workspace/attachment realpath 约束；`renderer/Markdown.tsx:447-470` 把 assistant markdown 绝对图片路径直接送进该 IPC。
- 影响：XSS / renderer bug / 模型输出的绝对路径可把本地任意图片/SVG 转 data URL 暴露到 UI。
- 建议：IPC 改 `{cwd,path}`，main 侧 realpath 限定 session workspace / staged / generated attachments allowlist。
- 阻塞 beta：是。

### M2 凭证和完整 cookie jar 明文 0o600 落盘（安全，确证）
- 证据：`main/index.ts:1595-1604` SafeStorageCipher 未安装、默认 PlaintextCipher；`:1782-1786` 接收保存；`CookieTab.tsx:125-132` 存完整 cookie jar；`TokenTab.tsx:42-48` 存 token/link secret。
- 影响：0o600 只防同机其他普通用户，不防恶意软件/备份同步/日志泄露；public beta 用户会放真实账号 cookie。
- 建议：发前接通 safeStorage + worker 解密；来不及则默认关闭/隐藏 cookie 凭证与 autoUse/autoInject，UI 明示「本地明文」。
- 阻塞 beta：是（除非降级为明确实验功能）。

### M3 browser automation / cookie 注入按全局 active guest，跨 session（已知项确认）
- 证据：renderer 已按 bucket 分区（`PanelArea.tsx:425-429`、`WebviewHost.tsx:23-32`）；但 main 侧 `active-guest.ts:13-20/26-35` 是全局最近 guest；`agent-bridge.ts:553-564` 向第一个窗口发无 session 的 `browser:open-url`；preload（`:171-172`）丢 session 信息；cookie 注入用 `activeGuest()?.session`（`agent-bridge.ts:483-492`）。
- 影响：session A 的自动化/InjectCredential 可能驱动/注入到 session B 聚焦的浏览器分区。
- 建议：guest registry 按 sessionId/bucket/partition 索引，所有 browser action 携带并校验目标 bucket。
- 阻塞 beta：若 browser automation 或 cookie 注入默认开启，是。

### M4 skills:uninstall IPC 可按 renderer 传入路径递归删目录，未绑定已列出 skill（安全，确证）
- 证据：`preload/index.ts:861-862` 暴露 `uninstallSkill(filePath, source)`；`main/index.ts:2104-2109` 只做类型/source 校验；`skills-service.ts:82-98` 只要求含 `SKILL.md` 且路径含 `/.code-shell/skills/`，随后 `fs.rm(recursive)`。
- 影响：被攻破 renderer 可删任意符合该形状的目录，未 realpath 到当前 project/user skill root。
- 建议：main 侧只接受 `{scope,cwd,skillName}` 自算路径，或要求命中 listSkills allowlist；删前 realpath 校验 exact root、拒 symlink。
- 阻塞 beta：是（破坏性 IPC）。

### M5 desktop 独立 typecheck 不绿，含真实错误（确证）
- 证据：`ChatView.tsx:768` `acceptFiles(files, origin)` 在 `:1450-1453` 漏传 origin；`file-search-service.ts:48-60` Promise 类型 `SearchEntry[]|null` 但 `done` 写成 `string[]|null`（`:85` 传 SearchEntry[]）；`settings-service.ts:156-162` 对 nullable `nextWorktree` 赋值；`index.ts:2272-2276` spread 非对象。
- 影响：release gate 失败；附件 picker origin 传 undefined（main `:2043-2052` 兜底成 paste，审计来源错）。
- 建议：先 build core/cdp dist 再修 desktop TS 错误，让 typecheck 绿。
- 阻塞 beta：是。

## Minor
- m1 renderer 崩溃/白屏只有日志无恢复 UX（`main/index.ts:1409-1417`）。
- m2 Markdown 代码复制直接 success toast、clipboard 失败静默（`Markdown.tsx:581-585`）。

## 已核实通过
- renderer 无 runtime import codeshell（只 type-only）✓
- attachment-service realpath 约束完整 ✓
- 文件面板读路径有 realpath containment ✓
- main/preload/renderer 流式 seq 主链路一致 ✓
- mobile 切 session 审批 replay 已存在 ✓

## 验证
- renderer import guard rg：只 type-only ✓
- desktop `bun test`：1140 pass/157 fail/22 err（失败多为只读沙箱 EPERM）
- desktop typecheck：失败（见 M5）
