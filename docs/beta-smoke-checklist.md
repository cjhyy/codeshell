# 测试版冒烟清单 + 分发说明 (0.5.0-rc.2)

## A. 桌面 App 冒烟(本机,发前必跑)

> **产物已打好(2026-06-25,见 audit 顶部 📦 段)**,在 `packages/desktop/dist/`:
> `code-shell-0.5.0-rc.2-arm64.dmg`(124M)/ `-arm64-mac.zip`(119M)/ `.dmg`(x64,129M)/ `-mac.zip`(x64,124M)。**本机 Apple Silicon 装 arm64 那个**;未签名,首次右键「打开」。

- [ ] 装 dmg / 解压 zip,拖进 Applications
- [ ] hover Dock 图标 → 名字是 `code-shell`(非 Electron)
- [ ] 双击打开(首次右键「打开」绕过 Gatekeeper)
- [ ] 主界面起来
- [ ] 子代理列表非空(seed 的 explorer/general-purpose/planner/researcher)
- [ ] 市场有源可逛(seed 的市场)
- [ ] 配 OpenAI provider → 跑一轮对话不崩
- [ ] 切一次模型不崩
- [ ] 用一个默认 agent 跑一次
- [ ] 让模型生成一张图(GenerateImage 可用)
- [ ] 关掉重开 → 上一会话能恢复
- [x] **cookie 登录全链路**(audit §1.3)—— ✅ 已真机验过(2026-06-24,commit `efe3ae7f`,§5.1-5.4 无问题):
  开独立登录窗登 YouTube → 点「保存」→ 凭证页出现该账号 → 切到另一账号 →
  让 AI `UseCredential`/`InjectCredential` 取用 → 浏览器面板以该账号身份可见登录态。
  关联 `project_browser_login_window`。**A 节其余项仍需打包后逐项真机走一遍。**

> 注:core / desktop 两包 `tsc --noEmit` 现均 0 error(2026-06-23 收口;旧文档曾误记 core 干净实则 9 红,已修;2026-06-25 再次复核两包 tsc 仍 0)。CI 卡 typecheck 不再是阻塞。

## B. npm 包冒烟

- [x] 干净目录 `npm i @cjhyy/code-shell@rc` —— ✅ 装好,三包全解析到 0.5.0-rc.2,0 漏洞
- [x] `code-shell --version` → 0.5.0-rc.2 —— ✅ 跑通无报错
- [x] **headless `run` 跑通一轮**(2026-06-25 验):`code-shell run "say hi"`(走 tui dist + 默认配置 gpt-5.5)→ 完成一轮 LLM 对话 + cost summary + 干净退出,无崩。**确认打包的 CLI 端到端引擎链路(bootstrap→LLM→响应→计费→退出)正常,且 dist 含本会话 core 改动无回归。**
- [ ] 交互式 TUI(REPL)起一次、跑一轮、**退出重进恢复会话**(交互+resume 部分仍需人工)

## C. 给熟人的分发说明

**桌面版(推荐)**
1. 下载对应芯片的 dmg(Apple Silicon 选 arm64,Intel 选 x64)
2. 打开 dmg,把 code-shell 拖进「应用程序」
3. 首次打开:右键图标 →「打开」→ 再点「打开」(绕过未签名拦截)
4. 在设置里配置你的模型 provider(API key)
5. 反馈:遇到问题直接发我 + 描述复现步骤;日志在 `~/.code-shell/logs/`

**命令行版(可选)**
- `npm i -g @cjhyy/code-shell@rc` 然后 `code-shell`

## D. 已知限制(测试版)
- mac 未做正式签名/公证 → 首次需右键打开
- 无崩溃自动上报 → 请口头反馈
- 凭证落盘:`settings.json` 的 API key 与 `credentials.json` 的 cookie 现为明文(文件已收紧 0o600,owner-only),尚未上 OS keychain / safeStorage 加密(roadmap §5 R-2,发后做)。

## E. 发布执行记录(最终 = 0.5.0-rc.2)

- **npm 包**:用 `bun publish --tag rc`(**不是** `npm publish` —— meta/tui 用
  `workspace:*` 依赖,只有 bun 会在发布时把它解析成具体版本;npm 会原样发出
  `workspace:*` 导致安装失败)。最终已发并**验证可用**:
  - `@cjhyy/code-shell-core@0.5.0-rc.2`
  - `@cjhyy/code-shell-tui@0.5.0-rc.2`
  - `@cjhyy/code-shell@0.5.0-rc.2`(meta;依赖已解析为 core/tui 的 rc.2)
  - **✅ 干净环境 `npm i @cjhyy/code-shell@rc` → `code-shell --version` = 0.5.0-rc.2,无报错。**
  - dist-tags 校验:meta `latest` 仍是 `0.3.0`(未污染),`rc=0.5.0-rc.2`。
- **⚠️ rc.1 作废(别发给熟人)**:rc.1 的 npm 包**装得上但跑不起来** —— 上一轮已发的
  `core@0.5.0-rc.1` 早于 tui 用 `mergePluginMcpServers`,该 export 缺失,装完跑 bin 抛
  `SyntaxError: does not provide an export named 'mergePluginMcpServers'`。npm 版本不可
  覆盖,故全量 bump 到 rc.2 用当前(互相兼容的)构建重发。**教训:发前必须真跑一次 bin,
  不能只看 `bun publish` 打印的 `+ pkg@ver`。**
- **桌面包**:`packages/desktop/dist/` 已出过 mac arm64+x64 的 dmg/zip(electron-builder,
  未签名,`CSC_IDENTITY_AUTO_DISCOVERY=false`)。
  - 已客观验证:`Info.plist` 的 `CFBundleName/DisplayName/Executable` 全为 `code-shell`;
    打包产物 `Contents/Resources/examples/agents/` 含 4 个默认 agent,
    `Contents/Resources/packages/desktop/resources/known-marketplaces-seed.json` 就位。
  - ✅ 已重出包到 **rc.2**:`packages/desktop/dist/` 现有
    `code-shell-0.5.0-rc.2{,-arm64}.dmg` 与 `...-mac.zip`(arm64+x64,~117–127MB);
    fresh arm64 app 再次客观验证 name=`code-shell`、`CFBundleShortVersionString=0.5.0-rc.2`、
    seed 资源齐。(出包时 hdiutil 偶发 detach 报错会自动重试恢复,产物完整。)
