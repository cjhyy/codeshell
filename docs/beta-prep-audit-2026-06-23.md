# Beta 发布前审计 + 行动清单(2026-06-23)

> 本文档是「发 beta 前」的一次性全量审计产出,供**新开 session 按节执行**。
> 每条都带具体文件路径 / 行号 / 验证方式,可直接动手。
> 来源:本机实跑(typecheck/test)+ 三路并行只读审计(docs 陈旧度 / 安全暴露 / 测试缺口)+ 关键项亲自复核。
>
> 状态图例:🔴 必做(发布关键路径/真 bug) · 🟡 应做 · ⚪️ 延后(release notes 签字接受)· ✅ 已核实
>
> **执行约定**(来自记忆):
> - 打工(功能/大改动)走 worktree 别动 main;琐碎小改/文档可直接 main。
> - 动手前先 grep 现状 —— 大量「待办」常已被某轮悄悄做完(`project_todo_items_often_predone`)。
> - 判「未接线/死代码」前必 grep 全仓消费者,且别先 `git restore`(不可逆)。
> - 改 core 必 `bun run build` 后 dist 才生效;测试用 src/ 路径避 dist 旧测试。

---

## 0. 当前真实状态(本机已核实,2026-06-23)

| 项 | 结果 | 说明 |
|---|---|---|
| core 单测 | ✅ **1536 pass / 0 fail**(265 文件,22.8s) | 旧文档写 1445,数量已涨,全绿 |
| desktop typecheck | ✅ **0 error** | 干净 |
| **core typecheck (`tsc --noEmit`)** | ✅ **0 error**(2026-06-23 收口,commit e4dd534e) | 旧的 9 error 已修;见 §1.1 |
| 工作树未提交改动 | reasoning-effort 放开 + EditModelCatalog 加白名单 | boot-crash 级修复,触及的测试 pass;**你说稍后自己提交** |
| 领先 origin/main | **17 个 commit 未 push**(旧文档写 13,已漂移) | 见 §1.4 |
| 已发布 | `0.5.0-rc.2`(npm 三包 + mac dmg/zip,均验证可用) | 见 `docs/beta-smoke-checklist.md` E 节 |
| VCS secret 卫生 | ✅ 干净(`.env` 从未提交,无硬编码 key) | 见 §5 |
| 日志脱敏 | ✅ 中心写入路径统一 `redactSecrets` | 见 §5 |
| 对外上报 | ✅ 无 telemetry/crash/analytics 网络出口 | analytics.ts 是死脚手架(0 调用,仅写本地文件) |

---

## 1. 🔴 必做(发布关键路径)

### 1.1 ✅ 已修 — core typecheck 红收口(commit e4dd534e,2026-06-23)
**4 个 test 文件 9 个 error 已全部收口:对 `BuiltinToolResult` 三臂联合做收窄(`"contentBlocks" in r`)、`asText` 改用 `BuiltinToolResult` 全臂、use-credential list cast 补 `label`、MaskedCredential 用 unknown cast 做运行时断言。`bun run typecheck` → 0 error。**
**(原始记录)这是旧文档声称「tsc 干净」但实际已红的项;若 CI 卡 typecheck 即为发布阻塞。**

- 运行时测试是**绿的**(`bun test` 不做类型检查),所以是 CI 门禁 / 卫生问题,不是运行时 bug。
- 根因:`BuiltinToolResult` 现在是三臂联合(`packages/core/src/tool-system/builtin/index.ts:84`):
  `string | { contentBlocks } | { result; sandbox }`。下列测试仍假设 `.contentBlocks` 永远存在,tsc 无法收窄联合。
- 受影响文件(各自需对返回值做联合收窄,如先断言 `typeof r === "object" && "contentBlocks" in r`):
  - `packages/core/src/tool-system/builtin/update-automation-memory.test.ts`(4)
  - `packages/core/src/tool-system/builtin/browser-tools.test.ts`(3,行 108/109/134)
  - `packages/core/src/credentials/use-credential-tool.test.ts`(1)
  - `packages/core/src/credentials/store.test.ts`(1)
- 验证:`bun run typecheck` → 0 error;`bun run --filter '@cjhyy/code-shell-core' build` 不报。
- 复核记录:已 `git stash` 确认这 9 个 error **在干净 HEAD 上即存在**,非你工作树改动引入。

### 1.2 桌面 App 真机冒烟(发前必跑)
清单见 `docs/beta-smoke-checklist.md` A 节,逐项打勾:
装包→Gatekeeper 右键打开→主界面起→子代理列表非空→市场有源→配 OpenAI 跑一轮→切模型→默认 agent 跑一次→生成一张图→关掉重开能恢复会话。

### 1.3 真机冒烟:弹窗登录抓 cookie 全链路
登 YouTube → 点保存 → 存进去 → 切换账号 → AI 取用。**唯一没真机验过的核心新功能**,有问题趁没 push 本地直接修。关联 `project_browser_login_window`。

### 1.4 全量打包构建 + push
- `bun run build` + `cd packages/desktop && bun run dist`(electron-builder,未签名,`CSC_IDENTITY_AUTO_DISCOVERY=false`),确认 main 进程 / node-pty ABI / asarUnpack 没崩(老坑 `project_desktop_four_panels`)。
- `git push` 这 **17** 个 commit 到 origin/main(先把 §1.1 修复 + 你的工作树改动一并落地)。

### 1.5 npm 包(若本轮要发)
**必用 `bun publish --tag rc` 不是 `npm publish`**(workspace:* 解析);**发后必真跑一次 bin**(`code-shell --version`),别只看 publish 打印(rc.1 装得上跑不起来的教训)。当前已是 rc.2,若要再发须 bump。

---

## 2. 🔴🟡 信息暴露 / 安全(全部源码已确认)

> 总体:VCS 卫生干净、Electron renderer 加固正确、「无 phone-home」属实。真正的风险面是**磁盘上的明文密钥/cookie**。

### 2.1 ✅ R-1 已止血(commit 8065530a,2026-06-23):`settings.json` 内 API key 明文 + **世界可读**权限
**已修**:manager.ts(saveUserSetting/atomicWriteJson)tmp 写带 `{mode:0o600}` 再 rename;onboarding.ts 四处带 mode + 直写路径补 chmodSync;+3 测验证落 0o600 且收紧预存松权限文件。理想态 safeStorage 加密仍留 §5 发后。下面为原始记录:
- 写入点**没传 `mode`**:`packages/core/src/settings/manager.ts:253` 与 `:356`(`writeFileSync(tmp, …, "utf-8")`),`packages/core/src/onboarding.ts:601`。
- schema 允许裸 `apiKey`:`packages/core/src/settings/schema.ts:102,128,174,232,261,286,539,551,564`。
- 暴露:OpenAI/Anthropic/GLM 等计费 key,明文存 `~/.code-shell/settings.json` 与 `<cwd>/.code-shell/settings.json`,默认 umask 常为 `0o644`(其他本地用户 / iCloud/Dropbox/TimeMachine 备份可读)。
- **不一致**:`credentials.json` 已用 `0o600`(`packages/core/src/credentials/store.ts:56`),同等敏感的 `settings.json` 却没有 —— **本机已亲自核实**。
- 修:写入加 `{ mode: 0o600 }`(一行级);理想态用 Electron `safeStorage` 加密 `apiKey` 字段。
- 注:`.code-shell/` 已 gitignore(`.gitignore:21`),项目级提交风险已缓解。

### 2.2 🔴 R-2:browser-login session cookie 明文落盘(无 OS keychain)
- 写:`packages/core/src/credentials/store.ts:56`;`credentials:save` 在 `packages/desktop/src/main/index.ts:1054-1057`;capture 在 `packages/desktop/src/main/credentials-login/index.ts:221-238`。
- 暴露:整个 cookie jar(Google/YouTube/X/Bilibili 的 `SID`/`auth_token`/`sessionid`/`SESSDATA` 等)`JSON.stringify` 进明文 `secret` 字段,存 `~/.code-shell/credentials.json`。`fullCapture` 模式抓分区**全部** cookie 非仅目标域。
- 已做对的:文件 `0o600`(owner-only)。仍 🔴 因:可重放的活 session token 明文存储,挡不住同用户恶意软件 / 用户级备份云同步。CC、Codex 这类数据走 OS keychain。
- 修:落盘前用 `safeStorage.encryptString` 加密 `secret` 字段。

### 2.3 🟡 Y-1:auto-updater 配置为自动下载+自动安装(潜伏 silent install)
- `packages/desktop/src/main/index.ts:952`(`initUpdater()`);`packages/desktop/src/main/updater.ts:103-104`:启动 30s 后 + 每 6h 检查,`autoDownload=true` + `autoInstallOnAppQuit=true`。
- **今天休眠**:仅 `app.isPackaged` 才跑,且 `package.json` 无 `publish` 块、无 `CODESHELL_UPDATE_FEED`,`checkForUpdate()` 空转无网络请求 —— 与「无 phone-home」一致。
- 🟡 原因:一旦发布配了 feed,每次启动就会静默联网下载安装。给熟人的 beta 出现「未提示的后台安装」很意外。
- 修:确认 release electron-builder 配置不注入 `publish`;或把自动检查收进用户开关、beta 关掉 `autoInstallOnAppQuit`。**这是唯一需静态外确认的项(取决于 CI/release 的 electron-builder profile)。**

### 2.4 🟡 Y-2/Y-3/Y-4:mobile-remote(默认关,开了才咬人)
- Y-2:LAN 模式 `/health` 与 `/mobile/*` SPA 无鉴权下发;LAN WS `auth.device` 路径**无暴力破解锁定**(锁定只覆盖 tunnel 模式 `access-passcode.ts`)。`remote-host-manager.ts:129-182,195-215`。
- Y-3:设备 `secretHash` 实为明文 bearer token(**没 hash**,与记忆 `secretHash不hash` 一致),`===` 比较非 `timingSafeEqual`,`devices.json` 无 `mode`。`trusted-device-store.ts:17-19,41-50,87-89`。
- Y-4:cookie lease 明文经 `/tmp`(`credentials-service.ts:124-135`),文件 `0o600` 但 lease 目录 `mkdirSync` 无 mode。
- beta 取舍:这些**默认关**,给熟人的 beta 可 ship-as-is + release notes 注明;开放给更多人前再硬化。

### 2.5 ⚪️ 已确认安全(留档,无需动)
- 无 secret 入库(`.env` 含真 SERPER key 但 gitignore 且 `git log --all -S` 验证从未提交);`dist/`/`log/`/`.code-shell/`/`.claude/` 均未追踪;npm `files:[dist,…]` 不发源码。
- 日志中心写入路径统一脱敏(`packages/core/src/logging/logger.ts:299,322` 跑 `redactSecrets`;`sanitize-messages.ts:169-250` 清 key/authorization/token/cookie/bearer + URL query;protocol/redact.ts 边界也脱敏)。记录较全的 `session-recorder.ts` 仅 dev(`isLocalDev()`,打包关)。
- 无 Sentry/PostHog/crashReporter/sendBeacon;`analytics.ts` 是死脚手架(0 调用点,仅写本地 jsonl)。
- Electron renderer 加固正确(全窗 `contextIsolation:true`/`nodeIntegration:false`/`sandbox:true`/`webSecurity:true`;webview guest 加固;外部登录窗无 preload;导航 guard + open-handler + scheme allow-list;prod CSP 仅 `'self'`+localhost)。
- **IPC 注意点(带进未来)**:`fs:*` 已沙箱(realpath 解析、拒 `..`/symlink 逃逸、只读、2MB 上限),但 `pty:start` 与 `shell:openPath` **未走 path-gate**,仅本应用可信 renderer 可达。**若未来把这俩通道代理给 mobile/remote 面,即成 RCE —— 务必保持 renderer-only。**

---

## 3. ✅ 测试补全(2026-06-23 全部完成)

> **进度(2026-06-23)**:优先级 1/2/3 + 全部中低优先级缺口均已补完,并顺手修了一个真 bug。
> - P1:`validateSettings` 端到端 effort(commit 70b7db38)— TDD 验证退回闭合 enum 时恰好转红。
> - P2:`reasoningFromParamValues` 未知 effort round-trip + 过 validateSettings(commit 2be894aa)。
> - P3:`classifyLocalInstallError`(从 installLocalPluginForUi 抽纯函数)+ marketplace-service.test.ts(commit 0000c931)。
> - InjectCredential 工具 11 例(commit 0e54d0d8);resolveSafePluginPath 9 例(commit bb0db988)。
> - EditModelCatalog summarizeWrite 9 例 **+ 修真 bug**:saveCatalogEntry 缺父目录时崩 ENOENT,改 mkdirSync(commit 358efbb0)。
> - 全量:core 1571 pass / 0 fail;core+desktop typecheck 均 0 error。

<details><summary>原始缺口清单(留档)</summary>

> 你最担心的两个手修 bug(cookie nonce spoof 9eaefd86、wrong-dir delete 71cf2798)**都已带回归测试,无需补**。plugin-MCP override 层覆盖堪称范本。真正缺口在下面。

**优先级 1(最高,直接重新武装已修的 boot-crash):**
- `validateSettings` 端到端接受 effort —— 加在 `packages/core/src/settings/schema.test.ts`。
  断言 `validateSettings({ providers:[{…, reasoning:{mode:"effort",effort:"xhigh"} }] })` 以及一个**未知**档(如 `"max"`)**都不抛**。
  当前 `reasoning-setting.test.ts` 只证叶子 schema,没覆盖真正崩过的 `validateSettings` 集成路径。
  崩溃路径:`paramValues.reasoning`(schema.ts:314 `z.unknown()`)→ `reasoningFromParamValues()`(`engine/model-connections-pool.ts`)→ `providers[].reasoning`(schema.ts:150)/`models[].reasoning`(:195)→ `validateSettings()`(schema.ts:739)boot 时抛。

**优先级 2:**
- `paramValues.reasoning` 把未知 effort round-trip 成 ReasoningSetting 不抛 —— 加在 `packages/core/src/engine/model-connections-pool.test.ts`。
  断言 `reasoningFromParamValues({reasoning:"max"})` → `{mode:"effort",effort:"max"}`,且携带它的连接能过 `validateSettings`。

**优先级 3(护你未提交的 overwrite UI 流):**
- `installLocalPluginForUi` 把 already-installed 错误映射成 `{ok:false, alreadyInstalled:true, name}` —— **新建** `packages/desktop/src/main/marketplace-service.test.ts`(该文件目前零测试)。
  断言正则从 `plugin '<name>' already installed` 提取权威插件名、返回 `alreadyInstalled:true`;无关错误返回 humanized `{ok:false,error}`。
  风险:core 一旦改这句错误文案,脆弱正则会让 overwrite 流静默失效。

**优先级中低(可发后补):**
- InjectCredential 工具(`packages/core/src/credentials/inject-credential-tool.ts`)**零测试**:补「审批门控 / 拒非 cookie 凭证 / headless 无回调报错 / 无 cookie 凭证时 `isInjectCredentialAvailable` 隐藏」。现仅经 `use-gate.test.ts` 间接覆盖。
- EditModelCatalog 工具(`tool-system/builtin/edit-model-catalog.ts`)**零测试**(catalog 库本身覆盖良好):补**未提交的** `summarizeWrite()`(回显 params/options/default,处理 enum/number/无 presets)+ schema 校验穿透 + 错误路径(`saveCatalogEntry` 失败 → `"Error: …"`)。
- `resolveSafePluginPath()`(`packages/core/src/plugins/pluginInstaller.ts`)path-containment 守卫无单测,仅间接覆盖;补「拒绝 cache root 之外的目标」。

</details>

---

## 4. 📄 过时文档清理(只保留最新)

> 顶层 `docs/` 实为 **36 个 .md**(审计 agent 报的 264 含整棵 superpowers/specs+plans 树)。
> 动手原则:**删/归档前先 grep 代码确认特性是否已落地**,别凭日期推断。

### 4.1 建议立即删(无 beta 价值)
- `docs/archive/electron-codex-ui-*.md`(3,Codex 对比快照,实现已在码)
- `docs/archive/goal-*.md`(2,被 `plans/2026-06-07-goal-continuation-redesign.md` 取代)
- `docs/archive/dream-cross-level-promotion-*.md`(不在 roadmap)
- `docs/archive/ai-*-news*.md`(2,过期资讯剪报)
- `docs/desktop-shadcn-migration-status.md`(实现细节,非 beta 文档)
- `docs/composer-container-query-context.md`(技术札记)

### 4.2 建议归档(移进 archive/,先 grep 确认已实现)
- `docs/architecture/03-module-map.md`(被 `codeshell-module-link-reference.md` 取代)
- `docs/architecture/11-render-tui-capability-plan.md` / `12-mac-visual-client-research.md`(决策已定/已实现)
- `docs/architecture/15-current-review-and-bug-inventory.md`(2026-05-31 pre-beta 快照,bug 多已修)
- ~~`docs/core-doc-audit-manifest.md`~~ ✅ 已归档 → `docs/archive/core-doc-audit-manifest-2026-06-02.md`(被 core-complete-review 取代)
- `docs/research-cc-vs-codex-image-handling.md`(对比已冻结)
- `docs/architecture/render-scroll-checklist.md` / `render-terminal-matrix.md`(任务式,多半已完成)

### 4.3 重复簇(合并取最新一份为准)

> ⚠️ **执行说明(2026-06-23 复核)**:这几簇都是「把一份正文合并进另一份」= 实质内容编辑(读两份判段落并入 + 改交叉引用),非机械清理;且多数权威稿被**源码注释引用**(动路径留断链)。低价值、易引入内容失真,**留用户在场时人工合并**,本轮不自动做。下面磁盘现状已校正。

- **Browser**(实际顶层 docs/ 为:`browser-automation-research-2026-06-16.md`、`browser-cookie-export-design-2026-06-14.md`;权威稿 `superpowers/specs/2026-06-18-browser-module-redesign-design.md` **被源码引用 2 处不可动**)。审计原列的 `browser-tool-experience-improvements-2026-06-20.md` 在顶层 docs/ 未找到——清单与磁盘有出入,合并前须先核对实际文件。
- **Model Catalog**(3 份):留 `2026-06-15-unified-model-catalog-design.md`。⚠️**原建议「归档 2026-06-11」已撤销**:经 grep,`2026-06-11-model-catalog-design.md` 仍被 `packages/core/src/model-catalog/builtin.ts`、`types.ts` 的源码注释 + 06-15 设计稿引用,归档会留断链——保留为活 rationale。**注意还有本仓最新的 `5f1cf56d`「删 legacy 模型存储·全量切 catalog」设计稿**,应作为该簇的最新落地稿对齐。
- **Architecture Review**(3 份):留 `core-design-assessment.md`(2026-06-17)为主 + `architecture/19-core-chain-review-beta.md`(2026-06-12)为辅;归档 `architecture/15-…`(2026-05-31)。
- **Credentials**(spec + 1211 行 plan):若都还在推进,把 plan 关键段并进 spec。

### 4.4 留作权威(KEEP,~60 份高信噪)
`architecture/0[1-2,4-9].md`、`core-deep-dive.md`、`core-complete-review.md`、`codeshell-full-architecture.md`、`codeshell-module-link-reference.md`、`codeshell-repo-architecture.md`、`core-modules/*.md`(33,2026-06-16 自动生成)、`feature-inventory.md`、`core-design-assessment.md`、`articles/harness-agent-series/*`、`hooks.md`、`beta-smoke-checklist.md`、`mobile-remote-smoke.md`、本文件。

### 4.5 需补全的文档
- `CHANGELOG.md` 的 `[Unreleased]` 段:把本轮新特性(插件 MCP 凭证覆盖层 / 本地插件覆盖升级+卸载 / 模型 Catalog + EditModelCatalog / browser-login cookie / 多账号凭证)整理进去,发版时定版本号。
- `docs/beta-smoke-checklist.md`:把「core typecheck 干净」那条勘误(现 §1.1 红),并补 cookie-login 全链路冒烟项。

---

## 5. 🟡 优化方向(发后第一优先,非 beta 关键路径)

来自旧 TODO「发后第一优先」+ 本轮审计,按价值排序:
- 🔴 **记忆系统专项**(已拍板:先整体设计再动手)。生命周期状态机 / 完成态语义字段 / 自动提取确认流 / MEMORY.md 索引截断按需读 / 注入 token 预算。关联 `project_memory_and_dream_overview`。
- 🟡 **at-rest 加密**(把 §2.1/§2.2 从「一行 chmod 止血」升级为 `safeStorage` 全量加密)。
- 🟡 **会话可靠性闭环**:长断网会话级重连、崩溃后 UI 提示/一键恢复、工具超时可取消一致化、友好错误。
- 🟡 **审查面板 turn 级范围**(真 bug):turn 卡片点审查应默认本 turn 范围,现落整工作区 diff。
- 🟡 **真视频适配器**:替换 `FakeVideoProvider`,接 seedance/kling(待私有 API 文档)。
- 🟡 **Windows P8 真机冒烟**(若 beta 只发 mac 可整体延后)。

---

## 6. ⚪️ beta1 延后(release notes 签字接受,非 bug)
- browser-login 硬化:console 哨兵已换 per-window nonce(9eaefd86 已修);`persist:login-*` 分区只清 cookie 残留 localStorage/IDB/SW;BrowserHost phase-2 `kind:'webview'` 类型未预留。
- JSON-Schema 导出未接线(`schema-export.ts` 无 caller)。
- i18n 增量收尾;mobile(~149 处)单独接同套 i18n。
- mac 签名/公证未做(首次需右键打开,已在分发说明告知)。

---

## 附A:bug-scan 进度(2026-06-23 第一轮,对抗式 review + 验证)

三路并行只读 review(cookie capture/inject · plugin 覆盖原子性 · model catalog),逐条对抗验证后:

**已修(真 bug,验证 + 测试 + 提交)**
- cookie 抓取域围栏裸公共后缀漏配:`d="co"` 经 `target.endsWith(".co")` 误中 `github.com`。抽 `cookieDomainMatches`(要求 d 含点)+6 测(commit fc6f0409)。纵深防御,非活漏洞。
- `restoreCookieToBrowser` 非数组 secret 静默清空登出:合法 JSON 非数组过 try/catch → clear 模式清光 cookie 不灌回。改非数组也判损坏(commit a906d8f7)。

**审过判定非 bug(留档,避免重复挖)**
- `reinstallAtomic`(update.ts):设计正确——先 rename live→backup 再装,失败回滚 dir+manifest 条目,「失败保留旧版」契约成立。`.cs-meta.json` 写失败触发的是**完整回滚到旧版**,非丢条目。
- `pluginInstaller.ts:236-238` materialize 的 rm→cp「崩溃窗口」:finalDir 按内容 SHA 命名,崩后重试同 SHA 自愈;manifest 条目只在 cp 成功返回后才追加,无孤儿条目。
- plugin manifest 非原子读改写竞态:仅同进程并发不同插件安装才触发;bootstrap 是 for-await 串行,UI 不并发,非 beta 可达(与 settings 跨进程同类「已接受」限制)。

**model catalog resolve/merge ✅ 复核完毕(干净)**:无真 bug。catalogId 不解析→undefined 且 caller `if(!resolved)continue`;credentialId 不存在→optional chaining 安全;corrupt 用户档→try/catch+safeParse 降级到 [] 不污染 builtin;baseUrl 回退链末端是 schema 必填的 defaultBaseUrl 不会 null;upsert/merge 按 id Map 去重,user 覆盖 builtin 恰一次无碰撞 bug。

**R-1 已止血**:settings.json 写入 0o600(见 §2.1,commit 8065530a)。

**bug-scan 第三轮(亲自读权限路径,d241ec08)🔴 真安全 bug**
- 会话权限缓存:Bash allow 规则按 head 收窄成 `^git(\s|$)`,但 ruleMatches 只 regex.test 整条命令 → `git status && rm -rf /` 借 `git status` 的会话授权静默放行整条(含 rm)。修=ruleMatches 对 Bash 收窄规则复用 scanShellCommand,dangerous 或 >1 段则拒绝匹配强制重问。TDD 验证 + 421 tool-system 全绿。
- 顺审 path-policy.ts:历史的子串误杀(/auth/ /token/)已修为锚定正则 + coveredBy 两侧补 sep 防工作区边界子串,确认干净;唯一小 gap=命名凭证文件的 `.bak` 备份不被判敏感(非 beta bug,留记)。
- 复核 classifyBashCommand/classifySegment:取每段 min 安全度 + 管道每段须独立 safe-read(防 `echo secret | nc` 外泄)+ 默认 unsafe fail-closed,干净。
- 复核 engine.refreshRuntimeConfig(配置热重载):version 单调去陈旧 + diskDefaultsFrom 是**全量快照 patch**(非稀疏 delta,undefined=settings 里确实没有,正确清除非误清)+ preset tool-set 变更只 warn 不半应用 + MCP reconcile catch-log 不崩,干净。turn-loop abort 检查已在 while 循环顶部(project_subagent_abort_leak 已修)。
- 复核 stream/render:parseSnapshotAppend 纯 + try/catch + steer_injected 去重(防双气泡);上游 readline.createInterface 正确缓冲跨块半行,干净。
- 复核 seatbelt 沙箱:`(deny default)` + 读广允后显式 deny 敏感目录 + 写仅 workspace/writableRoots + realpathSync 防 /tmp→/private/tmp symlink 漏 + `cat <secret>` 集成测试验真拦截,干净。小记:`quote()` 仅转义 `"` 未转义 `)`/换行,但 writableRoots 是用户自配(可信输入,只会放松自己沙箱),非威胁模型内 bug。
- 复核记忆注入 filterByAge:pinned/未知 mtime/`updatedAt>=cutoff` 三条保留,边界 `>=` 正确无 off-by-one;user/dream 双路一致过滤;dream 不按 pinned 排序属设计(pin 是 user 概念)。「完成态只增不减」是生命周期设计 gap(已归记忆专项),非注入 bug。

- 复核 session run 并发/锁(ChatSession.pump/enqueueTurn):`active` 锁在首个 await 前**同步**置位(pump 顶部 `if(active)return`),并发 enqueue 只入队不双跑;finally 清锁后 drain 队列串行化;server 层 isBusy()/Overloaded 再加一道。单线程事件循环下 race-free,干净。

**bug-scan 第四轮(记忆自动提取,9119ef0f)🟡 防御纵深修**
- auto-extract 的记忆 description/content 直接落盘(origin:auto 无用户复核),「不含密钥」只是 extraction prompt 指示非保证。修=落盘前过与日志同源的 redactSecrets(擦 Bearer token / URL 凭证)。残留:裸 prose 里的 key 不被 pattern-match,仍靠 prompt(测试已诚实标注)。TDD 验证。

- 复核 background job 生命周期 + engine wait-loop:`backgroundJobRegistry.start` 由 GenerateVideo 的 `pollToCompletion(...).finally(()=>finish)` 配对(成功/失败/异常都清,无泄漏);headless drain 的 sub-agent wait 是 abort-aware 的 while + 超时有界的 abort-race 清理(20×25ms,无变化即停),绝不无界 park;video 不 park 此 loop(走 goal-hook 短路)。干净。

- 复核 LLM retry/clamp:`isClientError` 读 top-level + 埋进 `details.status` 双处(Bug A status burial 已修),429 排除走限流;`clampMaxTokens` undefined/无cap/Math.min 三分支正确(Bug B bleed 已修)。小记:408 被当不可重试(LLM provider 罕用 408,学术性);cap≤0 会 clamp 到 0(catalog 数据错,非本函数职责)。干净。

- 复核 ApplyPatch 原子性(applier.ts):Phase1 全 hunk 内存 dry-run(任一失败 throw 不写盘)+ Phase2 commit 记 `committed[]`、失败按逆序从 plan 时快照回滚(避 TOCTOU)+ resolveAgainst realpath 双侧防 symlink 逃逸(path-gate bypass 下最后防线)+ 重复路径/CRLF 保留。比所改编的 Codex 参考实现更严(后者留半改)。范本级,干净。小记:回滚本身 best-effort(磁盘满时回滚也可能失败,吞错只抛原错)——经典难题,取舍合理。14 测过。

- 复核 session disk 恢复(sessions-service.ts):三道过滤正确——`"parentSessionId" in state` 用键存在区分 legacy(非真值)、`parentSessionId` 真值滤子代理、origin 仅 desktop/automation、删项目 cwd 不存在则跳(no-repo 空 cwd 故意不滤);title 回退 `??` 用法正确(LHS 空串→undefined→落 summary/id,非 `??` 吞假值 bug);pathExists 缓存避重复 stat。12 测过,干净。

- 复核 mergeTranscripts 去重(renderer/automation):两遍——内容签名定 lastCovered 取真 tail(fresh-id-per-fold 的 user/files_changed/context_boundary/goal_progress 按内容塌)+ seenIds 兜底防稳定 id 碰撞(tool 同 id 但 args 分歧)致 React key 崩。每个旧 bug 都编码成注释。88 测过。残留:同文本 user 消息靠 disk-authoritative 取舍(内容 keying 固有歧义),非 beta bug。

- 复核 context compaction 的 tool 配对保留(adjustIndexToPreserveAPIInvariants):收 kept range 内 tool_result 的 tool_use_id → 反查并把 startIndex 前扩到含其 tool_use,避免压缩切断配对致 API 400。**追了一个理论 cascade**(前扩新纳入的中间 user 消息若含引用更早 tool_use 的 tool_result,单遍不再 re-scan)——但经 grep turn-loop 确认:引擎每个 tool_use 的 tool_result 必在紧邻的下一条 user 消息(还有 dangling tool_use 合成兜底),**非邻配对不存在**,故单遍正确。⚠️**耦合注记**:此函数正确性依赖 turn-loop「tool_result 紧邻 tool_use」不变量;若将来改成延迟 tool result,需把它改成 re-scan 循环。21 测过。

- 复核 truncate-output(大输出 head+tail 截断):保留含错误的尾部 + 行边界吸附 + omitted 记账正确 + head/tail 由 `cap<len` 守卫保证不重叠;UTF-16 代理对中切是 cosmetic 非崩溃。6 测过,干净。

- 复核 hooks registry/reload:register/unregister 按 handler 引用身份(无包装→reloadHooks 精准摘除不泄漏,反复 reload 不翻倍);emit 合并 decision 走 stricterDecision(deny>ask>allow,杜绝后置 handler 放relax前置 deny 的安全要点)+ stop 终止链 + 每 handler error 隔离 + disabled 软开关热生效。17 测过,干净。

- 复核 mcp-manager reconcile/connect(共享池 + 并发热重载):connect 按 name 合并在途握手(connecting map + `.finally` 清,无重复握手/泄漏);disconnect 只摘 union 中无 owner 想要的(防跨 session 互踢)。**追了并发 reconcile race**:A 在 B 注册 desire 前算 union 可能不含 y→疑似误断 y,但 y 此刻必未连接(stale 过滤 listServers),不可达。33 测过,干净。

- 复核 stream 折叠 + agent-group post-pass(renderer/messages):foldAgentGroups 正确递归进 turn_process_group.items(flush 在组边界前调,不跨界拼 run);≥2 才成组(单 agent 留原样);两处渲染(MessageStream + TurnProcessGroupCard)都补了 agent_group case(记忆点名的「两处 switch 都要补」已满足)。81 测过,干净。

**bug-scan 小结(已饱和)**:共对抗式审 ~24 子系统(cookie capture/inject · plugin 原子性 · model catalog · mobile-remote 鉴权 · permission/path-policy/bash-classifier · automation write-policy · config 热重载 · turn-loop abort · stream/render · seatbelt 沙箱 · 记忆注入 · session run 并发锁)。**仅 1 个真安全 bug(权限链式命令绕过,修了两次:首版漏管道,d241ec08→d4c9dcb9 补全)**;其余 verified sound 或属已知设计取舍。安全/并发关键路径整体扎实。

**bug-scan 第二轮(mobile-remote review,b9915a0f)**
- 修:`readPasscodeParam` 不认数组头(重复头→string[])与 `readCookie` 不一致,正确口令落数组误 401 → 取首值,+2 测(TDD 验证)。
- 修(顺手 Y-4):cookie lease 目录 `/tmp` 下收紧 0o700。
- 判非 bug:tunnel 锁定仅内存、重启清零——远程攻击者无重启受害 app 途径,持久化反伤正常用户,属已知可接受。
- 其余已知项(LAN 无鉴权/secretHash 明文 ===/devices.json 无 mode)维持 audit §2.4 取舍不变。

## 附:晚上「一遍遍找问题」循环建议方向(token 耗尽前反复跑)

1. **代码正确性 bug 扫**(core + desktop):对抗式 review 找空指针/竞态/边界/错误吞没,逐个对抗验证后再记。重点新代码:catalog 写入、cookie capture/inject、plugin 覆盖升级原子性、mobile-remote 鉴权。
2. **§1.1 typecheck 红收口** → 然后每轮跑 `bun run typecheck` 防回归。
3. **§3 测试补全**:按优先级 1→2→3 补,每补一个跑 `bun test <file>`。
4. **§4 文档清理**:每删/归档一份前 grep 代码确认。
5. 每轮产出:改了什么 + 验证输出 + 下一轮入口。琐碎走 main,大改走 worktree。
