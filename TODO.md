# TODO

整理范围：来自 2026-07-01 Codex 规划与 Claude Code 只读复核。bug 类待办已全部修复或删除（记录在 git 历史与记忆）；Critical/High/Medium/Low/Follow-up/Hardening 均已清。

现状：只剩发布关键路径（beta1 用户亲自做）+ 延后项（记 release notes）+ 大路线图（留存方向）。

# 发布关键路径（beta1，必须用户亲自做）

> 原 `TODO-beta1.md` 合并进来。代码侧 review 确认 bug 已修;剩下是验证 + 打包 + 发布,AI 无法代做。

- 🔴 **真机冒烟:弹窗登录抓 cookie 全链路** — 登 YouTube → 保存 → 切换账号 → AI 取用。唯一没真机验过的核心新功能。关联 `project_browser_login_window`。
- 🔴 **桌面 App 冒烟**（本机,发前必跑）:装包→Gatekeeper 右键打开→主界面→子代理列表非空→市场有源→配 OpenAI 跑一轮→切模型→默认 agent 跑一次→生成一张图→关掉重开能恢复会话。
- 🔴 **全量打包构建**:`bun run build` + `cd packages/desktop && bun run dist`（electron-builder,未签名,`CSC_IDENTITY_AUTO_DISCOVERY=false`），确认 main 进程 / node-pty ABI / asarUnpack 没崩。
- 🔴 **`git push`** 未推的 commit 到 origin/main。
- 🟡 **npm 包**（若本轮要发）:**必用 `bun publish --tag rc` 不是 `npm publish`**（workspace:* 解析）;**发后必真跑一次 bin**（`code-shell --version`）。
- 🟡 **i18n 全语言点一遍**:中/英切换走主流程,确认无未翻译泄漏 / 无 localStorage 报错。
- 🟡 **Windows P8 真机冒烟**:代码 P1–P8 全实现 + CI 绿,但无打包 job、无真机点验。beta1 若只发 mac 可整体延后。关联 `project_windows_port`。

---

# beta1 延后（非 bug，记 release notes）

- ⚪️ **browser-login 硬化**:① 已修(per-window `randomUUID()` nonce);② `persist:login-*` 分区只清 cookie,localStorage/IndexedDB/SW 残留 → 改非持久分区或 `clearStorageData`;③ BrowserHost phase-2 webview 收编未预留类型/未抽共享 helper。
- ⚪️ **JSON-Schema 导出未接线**:`schema-export.ts` 无 caller → 宿主启动写 `~/.code-shell/settings.schema.json` 或 release notes 注明不暴露。
- ⚪️ **i18n 收尾（增量）**:`"新对话"` 哨兵常量化;非 React helper 硬编码 localStorage key 应 import KEY;mobile(~149 处)单独接同套 i18n。

---

# 大路线图（beta1 不做，留存方向）

- **浏览器自动化 P4**（MVP 已实现）:留后=交互审批弹窗 / 无人值守隐藏窗口 / 视觉兜底 SoM。
- **Cookie Lease**（`docs/browser-cookie-export-design-2026-06-14.md`）:浏览器登录态→CLI 工具受控桥接(按域/按任务/一次性/审批 + 三层清理)。整套未实现。
- **Workspace / Profile / 数字人**（`docs/workspace-profile-讨论稿.md` v0.5）:base preset + 主指令 + 可移植经验三层 / 可切换 / Team Board。下一步 P3 seedance 手动落地。
- **Workspace 数据源绑定**（P4）:资源模型 / link 外部源(Figma/issue/云盘)/ scope 分配。大子系统。
- **远程控制 / 跨代理编排**（P5）:SSH / 扫码配对 / 远控会话 / 编排 Codex+CC / 安全边界。大子系统。
- **手机遥控**（低优）:房间续跑 + 手机驱动真 codeshell session;现 mobile 无 Markdown 渲染。
- **聊天软件接入（channel，参考 OpenClaw）**:微信/Telegram 做成可插拔 channel 前端。要点:① core 保持 channel-agnostic,平台接入做外部插件;② 接入做成一类凭证进 CredentialStore(微信扫码登录 token 存本地,Telegram bot token);③ 扫码微信号绑死为收发身份 + 必配 allowlist + 绑定目标 agent;④ 微信当前只私聊 + 媒体,不支持群聊。未立项。
- **工程质量 P7**:builtin tools 集成测试(已补 65 例)/ E2E / CI 覆盖率 >60% / 性能 / 文档。
  - **Electron e2e 设施**（playwright 现是孤儿依赖）:用 `_electron` API 驱动真机 app,沉淀 `verifier-electron` 基座。最小落地:`playwright.config.ts` + `e2e/`;`launchApp()` 按 title/URL 抓主窗（**别用 `firstWindow()`,会抓 DevTools 窗**）;第一个用例验浏览器面板;`package.json` 加 `test:e2e`。难点:抓错窗 / webview 嵌套需 `frameLocator` / node-pty 按 Electron ABI 重编 + CI 需 `xvfb-run`。约半天。
- **Markdown 渲染一致性**（desktop/TUI）。
- **view_image TUI inline**（iTerm/kitty graphics protocol）+ 历史图降级文字摘要省 token。
- **设置/命名清理**:settings/repo/workspace 命名收口;ModelSection 1065 行深度重排。

### 明确不做（已决策，留因）

- **每轮主动请求压缩 / token 预算动态调档**:与 Anthropic prompt cache 冲突,固定 ratio 门控刻意保留。
