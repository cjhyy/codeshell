# Beta 发布前审计 + 行动清单(2026-06-23)

> ## 🌙 夜循环交接(2026-06-23,回来先读这段)
>
> 一整轮自主 bug-scan + 修复 + 文档整理。**~85 commit 全在本地 main,均未 push**(push 是你的决定,我没动)。
>
> **修了 9 类真 bug(全带回归测,TDD)**——最重的两个:
> - 🔴 `killProcessGroup`/`groupAlive` 无 pgid 守卫:pgid=0/1 时 `kill(-0)` 杀自身进程组、`kill(-1)` 杀你所有进程;pgid 从 orphan 记录磁盘读回可触发。**TDD 铁证:移守卫跑测试真把 test runner 自己 SIGKILL 了(退码 144)**。已修 95591130 + 顺修 resident-agent 同类 0a728764。
> - 🔴 权限会话缓存按 head 收窄被链式命令绕过:批准 `git status` 后 `git status && rm -rf /` 静默放行整条。修在共享 `ruleMatches`(覆盖 session-cache + 持久 project 规则两消费者)d241ec08,首版漏管道 d4c9dcb9 补全。
> - 其余:R-1 settings.json 0o600(**三个写入点,首轮漏第三处 engine,已补** e56825d6)、cookie 域围栏裸公共后缀、restoreCookie 非数组 secret 静默登出、记忆自动提取漏 redact、saveCatalogEntry 缺父目录崩、resume 损坏 state.json 抛裸 SyntaxError、token-counter 编码器 import 漏 catch。
>
> **覆盖**:~37 子系统 + 7 跨切模式(process.kill / JSON.parse / Number / match-deref / floating-promise / IPC-cast / effect-订阅)对抗式审,逐条溯源验证(含多个「以为可达、溯源证伪」)。详见**附A 覆盖矩阵**。最关键结论:唯一不可信边界 mobile-remote WS 证实健壮。
>
> **状态**:core ~1602 / desktop 924 / tui 81 · core+desktop tsc 0 err · core build 0 · 工作树净 · dist 与 src 一致。⚠️ **全量 core `bun test` 有 1 个 flaky 测试**(sleep abort-listener-leak,非确定·隔离稳过·产品代码正确·非我引入)——间歇 CI 红,详见 §2.4.6,建议你修测试时序断言。
>
> **本轮 fix commit 速查(13 个,供 push 前逐一 review)**:
> `fc6f0409` cookie 域围栏 · `a906d8f7` 非数组 secret · `8065530a` R-1 0o600(manager+onboarding) · `b9915a0f` passcode 数组头+lease 0o700 · `d241ec08`+`d4c9dcb9` 权限链式绕过(+管道) · `9119ef0f` 记忆 redact · `e56825d6` R-1 第三写入点 engine · `95591130` killProcessGroup pgid 守卫 · `0a728764` resident-agent pid · `d423319d` resume 损坏 state.json · `c6e9b3a7` token-counter catch · `5ac51235` typecheck 收口(你 merge 的 send_input 带来的红) · `358efbb0` saveCatalogEntry mkdirSync(在 §3 提交里)。其余为 test 补全 + 文档。
>
> **🟡 给你的一个发现(没擅自改)**:你 session 期间 merge 的 `send_input 续接`(a0b55219)resume 路径**缺「agent 仍在 running」并发守卫**——背景 agent 没跑完时再 send_input 会让两个 Engine 交错写同一 child transcript。我只修了它的 typecheck 红,逻辑没动(UX 该你定)。详见 §2.4.5。
>
> **等你定的**:① push 这 ~98 commit;② §1.2/1.3 真机冒烟(cookie 登录全链路是唯一没真机验的核心新功能);③ §1.4 全量打包;④ R-2 cookie safeStorage 加密(改凭证格式,该开 worktree 你在场做);⑤ send_input 并发守卫(§2.4.5)。
>
> ---

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
| core 单测 | 🟡 **~1602 pass**(273 文件) | 隔离全绿;⚠️**全量套件下 1 个 flaky**(sleep abort-listener-leak,非确定·产品代码正确·非夜循环引入)——见 §2.4.6 |
| desktop 单测 | ✅ **923 pass / 0 fail** | 全绿 |
| tui 单测 | ✅ **81 pass / 0 fail** | 全绿 |
| desktop typecheck | ✅ **0 error** | 干净 |
| **core typecheck (`tsc --noEmit`)** | ✅ **0 error**(2026-06-23 收口,commit e4dd534e) | 旧的 9 error 已修;见 §1.1 |
| core build | ✅ **exit 0** | dist 生成正常,gitignored |
| 工作树未提交改动 | ✅ 干净 | 所有夜循环工作均已 commit |
| 领先 origin/main | **~84 个 commit 未 push**(夜循环大量审计/修复) | 见 §1.4;push 仍待用户决定 |
| **夜循环成果(2026-06-23)** | 9 类真 bug 全修+回归测;~36 子系统+7 跨切模式对抗式审 | 见附A 覆盖矩阵 |
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
**已修**(三个写入点全覆盖):manager.ts(saveUserSetting/atomicWriteJson,8065530a)+ onboarding.ts 四处(8065530a)+ **engine.ts persistActiveModel(e56825d6,切模型时写 model.apiKey,R-1 首轮漏扫的第三处)**;均 tmp 带 `{mode:0o600}` + chmodSync 收紧预存文件;+4 测。理想态 safeStorage 加密仍留 §5 发后。下面为原始记录:
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
- Y-3:设备 `secretHash` 实为明文 bearer token(**没 hash**,与记忆 `secretHash不hash` 一致),`===` 比较非 `timingSafeEqual`,~~`devices.json` 无 `mode`~~。`trusted-device-store.ts:17-19,41-50,87-89`。**✅ devices.json 0o600 已修(4419d366)**;剩 `===`→timingSafeEqual + secretHash 真 hash 留本桶给用户(开放给更多人前)。
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

> 复核(2026-06-23,防「标延后实已做」):抽查两条 code 级声明仍准确——`schema-export.ts` 的 `settingsJsonSchema`/`writeSettingsSchemaFile` 仅 index.ts:434 re-export,**无实际 caller**(确属未接线);`browser-host/index.ts:19` 只有 `kind:"window"`,**webview 变体未预留**(确属 phase-2)。§6 可信。
- browser-login 硬化:console 哨兵已换 per-window nonce(9eaefd86 已修);`persist:login-*` 分区只清 cookie 残留 localStorage/IDB/SW;BrowserHost phase-2 `kind:'webview'` 类型未预留。
- JSON-Schema 导出未接线(`schema-export.ts` 无 caller)。
- i18n 增量收尾;mobile(~149 处)单独接同套 i18n。
- mac 签名/公证未做(首次需右键打开,已在分发说明告知)。

---

## 附A:bug-scan 结果(2026-06-23 夜循环,对抗式 review + 逐条溯源验证)

> 方法:先 3 路并行只读 review,再亲自读关键路径;每个可疑点都构造具体 race/cascade/bypass 假设并溯源证实或证伪;真问题先写失败测试(TDD)再修。

### 1) 已修真问题(全部带回归测试 + 已提交 main)

| 严重度 | 问题 | 修复 | commit |
|---|---|---|---|
| 🔴 安全 | 会话权限缓存按 head 收窄被链式命令绕过:`git status && rm -rf /` 借 `git status` 授权静默放行整条 | ruleMatches 对 Bash 收窄规则复用 scanShellCommand,dangerous/多段/**含管道**则拒匹配重问(**修两次**:首版漏管道) | d241ec08 + d4c9dcb9 |
| 🔴 安全 | settings.json 明文 key 世界可读(0o644)·**三个写入点** | manager + onboarding 收紧 0o600;深扫又补漏掉的 engine.persistActiveModel | 8065530a + e56825d6 |
| 🟡 安全 | cookie 抓取域围栏裸公共后缀漏配:`d="co"` 误中 `github.com` | 抽 cookieDomainMatches(要求 d 含点),+6 测 | fc6f0409 |
| 🟡 安全 | `restoreCookieToBrowser` 非数组 secret 静默清空登出 | 非数组也判损坏抛错 | a906d8f7 |
| 🟡 安全 | passcode 头数组(重复头)不认致正确口令误 401 | readPasscodeParam 取首值,+2 测;顺收紧 cookie lease 目录 0o700(Y-4) | b9915a0f |
| 🟡 卫生 | 记忆自动提取直接落盘,密钥仅靠 prompt 防护 | 落盘前过 redactSecrets(擦 Bearer/URL);残留:裸 prose key 仍靠 prompt(已诚实标注) | 9119ef0f |
| 🟠 健壮 | saveCatalogEntry 缺父目录崩 ENOENT | 写前 mkdirSync | 358efbb0 |
| 🟠 健壮(灾难性 if 触发) | killProcessGroup/groupAlive 无 pgid 守卫:pgid=0→`kill(-0)` 杀自身进程组、=1→`kill(-1)` 杀用户所有进程;pgid 从 orphan 记录读回,损坏记录可触发 | 入口加 `!isInteger\|\|<=1` 守卫 no-op;TDD 铁证(移守卫测试 SIGKILL runner,退码 144) | 95591130 |
| 🟠 健壮 | resident-agent.stop 负 pid kill 漏 pid=1(同 killProcessGroup 类,pid 非磁盘往返仅理论可达) | 统一加 `>1` 守卫,≤1 回退 child.kill | 0a728764 |
| 🟠 健壮 | resume() 损坏 state.json 抛裸 SyntaxError(逃过只 catch SessionError 的调用方→session 打不开);state.json 唯一非原子写在 create() | resume 读包 try/catch→SessionError;create() 改 tmp+rename | d423319d |
| 🟢 健壮(低危) | token-counter 编码器 import 无 `.catch`→corrupt 安装时 unhandled rejection(本意是 chars/4 fallback) | 补 `.catch(()=>{})` 让静默 fallback 成立 | c6e9b3a7 |

### 2) 覆盖矩阵(~25 子系统对抗式审过,结论=干净/已修;括注追过并证伪的假设)

| 子系统 | 结论 |
|---|---|
| cookie capture/inject · 多账号切换 | 修 2(见上)+ 余干净 |
| plugin 安装/覆盖升级/卸载原子性 | 干净(reinstallAtomic 回滚正确·materialize 崩溃自愈·manifest 竞态非 beta 可达) |
| model catalog resolve/merge | 干净(id Map 去重 user 覆盖 builtin 恰一次·corrupt 档降级不污染) |
| mobile-remote 鉴权 | 修 1(passcode 头)+ 已知项维持 §2.4 取舍 |
| permission session-cache | 修 1(链式绕过,见上) |
| path-policy | 干净(锚定正则·coveredBy 补 sep;小 gap=命名凭证 `.bak` 不判敏感) |
| bash-classifier | 干净(每段 min 安全度·管道每段须独立 safe-read·默认 unsafe) |
| automation write-policy | 干净(三档 + 未知回退最安全,全 fail-closed) |
| config 热重载(refreshRuntimeConfig) | 干净(version 单调·全量快照 patch·tool-set 变更只 warn·reconcile catch-log) |
| turn-loop abort | 干净(signal 检查在 while 顶部,project_subagent_abort_leak 已修) |
| stream/render parse | 干净(parseSnapshotAppend try/catch + steer 去重·readline 缓冲半行) |
| seatbelt 沙箱 | 干净(deny default·realpath 防 symlink·cat 集成测;小记 quote 未转义 `)`/换行,但 writableRoots 可信自配) |
| 记忆注入 filterByAge | 干净(边界 `>=` 无 off-by-one·双路一致) |
| session run 并发锁 | 干净(active 锁首 await 前同步置位·队列串行·server isBusy 双保险,race-free) |
| background job 生命周期 + wait-loop | 干净(.finally 配对无泄漏·abort-aware + 超时有界,绝不无界 park) |
| LLM retry/clamp | 干净(isClientError 读双处 status·clampMaxTokens 三分支;408/cap≤0 学术性边角) |
| ApplyPatch 原子性 | **范本级**(dry-run + 逆序快照回滚 + realpath 防逃逸;比 Codex 参考更严;14 测) |
| session disk 恢复 | 干净(三道过滤正确·title `??` 无吞假值·pathExists 缓存) |
| mergeTranscripts 去重 | 干净(内容签名 + seenIds 兜底,旧 bug 编码成注释;88 测) |
| context compaction tool 配对 | 干净(单遍正确,**依赖 turn-loop「result 紧邻 use」不变量**——改延迟 result 须改 re-scan 循环) |
| truncate-output | 干净(保留错误尾部·行吸附·不重叠) |
| hooks registry/reload | 干净(身份制 register/unregister 不泄漏·stricterDecision 杜绝放松前置 deny) |
| mcp-manager reconcile/connect | 干净(在途握手合并不泄漏·共享池只摘无 owner 想要的;并发 race 不可达) |
| stream 折叠 + agent-group post-pass | 干净(递归进 turn_process_group·两处渲染都补 agent_group case) |
| replay orphan-agent seal | 干净(仅 disk-rebuild 路径调·flush 不丢内容,不误封活 agent) |
| WebFetch SSRF | 干净(每跳 manual-redirect 重验 host+DNS→IP 块表·IPv4/IPv6/云元数据全覆盖·跨域剥凭证·hop 限);TOCTOU/DNS-rebind 残留**已在 a3 设计文档显式记为 out-of-scope** + 缓解理由,非疏漏;10 测) |
| provider-auth / 首用 apiKey | 干净(explicit>authCommand>env;空串经 `if(config.apiKey)` 当缺失不传 `""`;全缺→SDK 快速清晰报错非中途 401;baseUrl 交 SDK 归一不双斜杠);12 测 |
| desktop fs IPC 沙箱(只读) | 干净(lexical `..` 拒 + realpath 双侧 containment 防 symlink 逃逸;只读三 API 故 target 必存在→realpath 必跑足;不存在叶的 lexical 兜底仅写路径才危险而本服务无写;目录列举逐项 realpath 跳越界 symlink + 2MB 上限 + SKIP);7 测含 escape 用例) |
| askUser 跨进程审批通道 | 干净(requestId 配对·5min 超时 backstop·cancel 显式 resolve pending+清 timer 防挂死/泄漏·per-resolver try/catch;worker 死经 agent-bridge error/exit→lifecycle 事件→preload 拒 pending 不挂 UI);36 protocol 测 |
| generate-image/video 参数+凭证 | 干净(prompt required+trim+清晰错;apiKeyRef **单跳**故循环/链不会死循环·dangling ref fail-safe 不可用;prefer 命中走显式无静默 fallback);两工具 25 测含 dangling-ref 用例 |
| background-shell 增量读 + 生命周期 | 干净(agentReadOffset 绝对游标 survives 环绕;sliceFromAbsolute 双 clamp 防驱逐数据负 subarray,落后读者优雅降级取窗口起点不崩;读后游标跳 totalWritten 无 lag/重读,同步无交织丢字节;kill 仅显式 killSession/killAll,无 idle-sweep 杀,dev server 不被收割);22 测含 orphan-recovery |
| ApplyPatch V4A 解析器(LLM 输入面) | 干净(畸形输入全抛结构化 PatchParseError·caller try/catch 转 `Error:`·循环全由 length 界定;parseUpdateChunk 非抛返回必 `consumed≥1`→外层 while 必进不死循环);14 测 |
| transcript JSONL 持久化/load | 干净(per-line parse 隔离:torn 末行/坏行 try/catch 跳过不崩;load 后 repairToolResultPairs 双向修:孤儿 tool_use 合成 error result、孤儿 tool_result 滤除→序列对 LLM 始终合法);与 compaction 配对 + replay seal 构成「中断会话残留处理」三件套一致;54 测 |
| **跨切**:全仓 `process.kill`/负 pid | 4 点:killProcessGroup(已加守卫 95591130)+ resident-agent.stop(已加守卫 0a728764)+ lsp child.kill() 无 pid 安全 + Heartbeat process.kill(pid,0) signal-0 仅探测不投信号安全。2 个负 pid 点现都有 `>1` 守卫。 |
| **跨切**:全仓 `JSON.parse(readFileSync)` | 启动/易损路径全有 try/catch 降级:installedPlugins/loadPluginHooks/loadPluginMcp/list.ts(逐项 skip)均「corrupt→empty/null/skip」+ 显式「must not break startup」注释;install-time 的经 install 编排 `{ok:false}` 不崩。纪律统一。 |
| **跨切**:全仓 `Number()`/`parseInt` | 干净:watchdog/sleep 用 `\|\|default`(NaN→默认);port 检测有 `1..65535` 范围 check 挡 NaN;LSP content-length 是 `(\d+)` 正则保证非 NaN;theme/format 操作正则数字组。无 silent-NaN-into-logic。 |
| **跨切**:`match(...)[1]` 解引用 | 干净:无 unguarded(一律先赋值再 null-check)。 |
| **跨切**:floating promise(`.then` 无 `.catch`) | 扫出 1 修(token-counter c6e9b3a7);mcp-connect 两参 .then(reject)、agent 背景尾随 .catch、title-gen .catch 均安全。 |
| **跨切**:IPC/cast 边界(`as T` 后用) | 干净:**桌面 renderer→main**(可信)按风险校验——破坏/建文件 op 验 typeof,只读/coercion-safe 的轻校验,符合信任模型;**mobile-remote WS**(唯一不可信边界)`JSON.parse(...) as MobileClientEvent` 健壮——malformed→caught、缺字段经 Map.get/find 安全返「无效」、auth-gated 未授权只能 pair/auth(均 undefined-safe),不能崩 main 或绕 auth。79 mobile-remote 测 |
| **跨切**:renderer effect IPC 订阅泄漏 | 干净:每个 `window.codeshell.on*` 要么 `const off=...` 在 cleanup 调、要么 effect 直接 `return on*(...)` 当 cleanup(main.tsx PopoutBrowser);无未退订订阅。219 useEffect 中订阅类全有 cleanup。 |
| arena 证据并发收集 | 干净:runProviderWithTimeout 总 resolve 不 reject(race[work,timeout]+try/catch→`[]`+warn),故 `Promise.all` 不被单个失败/超时拖垮;cleanup 清 timer(修过 spurious-timeout)+ 摘 abort 监听;timer.unref 不挂活进程;abort→全 pending 解 `[]`。20 测 |
| cost-tracker 算账 | 干净(显示用·uncachedInput `Math.max(0,...)` 防负值 double-bill·lookupPricing 必返 DEFAULT 兜底);无负成本/NaN。无专测但已守且非关键路径 |
| arena digest-builder 大小 | 干净(**追了「N packets 求和无界→超 context」**:经查 buildDigest 不拷全 ledger,只收 `relevantClaimIds` 引用的 packets(claim.evidencePacketIds),按轮聚焦;per-field slice(2000)+excerpts.slice(3);ledger 增长有 WARN_PACKETS backstop)。病态单 claim 引数千 packet 仅理论,非 beta bug |
| RunLock / lockfile | 干净(proper-lockfile stale 60s 自动回收崩溃残留锁·`retries:0` 快失败不阻塞·missing_target vs locked 区分失败因·never-throws;lockfile.ts 用 `createRequire(import.meta.url)` 修 ESM「require not defined」致「Run now does nothing」+ 懒加载避 graceful-fs 8ms 进 startup,project_runlock_esm_bug 已修)。29 测 |
| model-fetcher 外部 /models 解析 | 干净(never-throws 契约:全管道在 try/catch→`errorResult({models:[],error})`;per-kind 解析 `?? []` 容缺/错 shape;provider 返回 garbage JSON 不崩,降级空列表)。外部 IO 防御到位,无专测但 degrade-to-empty 非崩溃面 |
| capability 折叠(skills/plugins/agents/hooks) | 干净(memory「易漏 readDisabledAgents 折叠」已处理:agents 有独立 readDisabledAgents 镜像 readDisabledLists,getAgentDefinitions 应用它+缓存键含 disabled 列表;四类共用 effectiveDisabledList 三态:on=re-enable/off=disable/inherit=keep;全 try/catch→[] 不throw)。58 测 |
| cron 调度睡眠唤醒(**解决旧 memory 未修项**) | 干净:`isCronMisfire` 90s grace——醒来 timer 超 90s 过点=misfire→跳过+重 arm 到下个正确 occurrence,不补跑(project_automation_kkg28 的「06:56 乱跑」**已修**);nextRun forward-recompute 不 catch-up。74 automation 测含 06:56 回归 |
| automation memory 写入(per-task memory.md) | 干净:核心 UpdateAutomationMemory 调注入 sink 不自 try/catch,但 executor(executor.ts:392)是**通用错误边界**——sink 抛(磁盘满/EACCES)被 catch→记 failed tool result 喂回模型「must not kill the turn」,run 不崩。8 测 |
| session disk 恢复 / draft 处理 | 干净:renderer loadSessionIndex 用 `activeSessionId !== undefined`(非 `??`)——持久 null=合法 draft 保留,仅 legacy 缺字段才落 sessions[0](project_draft_session_autojump_bug 已修+注释);解析全 try/catch→empty。配 main sessions-service 三过滤(前已审)+disk 权威源,「清 localStorage 不丢数据」端到端 sound。923 desktop 测 |
| agent-definition 加载/解析 | 干净:parseAgentDefinition 对畸形(缺 frontmatter/坏 YAML/缺 name/desc)抛结构化错,但 loadFromDirs **per-file try/catch→warning+continue**(一个坏 role 不崩全部/不阻 agent 列表);disabled-after-merge 使 user override disabled plugin role 正确;override/shadowedSources 精度;send_input +6 改未破坏隔离。15 测 |
| **send_input 续接(用户新 merge 特性,read-only review)** | resume 解析正确(registry→on-disk→clean error)+**重 resolve tool/skill scope 防 restricted role 续接时夺回全工具集**(安全要点已处理)+role-removed 降级 bare continuation;transcript-translator switch+default 不崩、display-only;namespacePluginSkills 已namespaced 不双前缀(已测 agent.resolve-type:78)。**1 个真发现**:缺「agent 在 running」并发守卫(§2.4.5,已标注给用户,未擅改) |

### 2.4.6) 🟡 给用户的发现:sleep.test 的 abort-listener-leak 测试在全量套件下 flaky

> 全量 `bun test`(core)下 `sleepTool abort-listener cleanup > does not leak abort listeners across normal completions` **非确定性失败**(连跑三次:1 fail / 2 fail / 0 fail);**隔离单跑稳过**(3 pass)。非本 session 引入(未碰 sleep.*)。
- **产品代码正确**:`sleep.ts` 正常完成时 timer 回调先 `removeEventListener("abort",onAbort)` 再 resolve,abort 路径 `{once:true}` 自摘——**不泄漏**。
- **flaky 根因**:测试用 `getEventListeners(ac.signal,"abort").length` 比较 before/after。该 API 是 node inspector/util 系,在 bun 全量套件并发/GC 下计数有时序噪声;`for` 循环内连续 await 短 sleep,某次清理微任务与计数读取的相对时序在高负载下不稳。
- **影响**:间歇 CI 红(非产品 bug)。**建议(你定)**:循环后加一个 `await Promise.resolve()`/微任务让清理 settle,或改断言为「不单调增长」而非精确相等,或标 `.skip` 待 bun 端核实。我没擅改(是别人的测试 + bun getEventListeners 行为需你确认)。
- ⚠️ **核实坑**:`bun run typecheck` / 隔离测试都不会暴露——只有**全量 core `bun test`** 偶发。CI 若跑全量会间歇红。
- **同类潜在风险(grep 全仓后)**:`apply-patch/cache-invalidate.test.ts:51` `expect(fileCache.size).toBe(0)` 是**同一脆弱模式**(共享单例 `fileCache` 精确计数;并发测试若 `.set` 一项会 flake)。未观察到它实际 flaky,但建议改 `expect(fileCache.has(abs)).toBe(false)`——更准确测「绝对键被删」(正是该测试注释的本意),且免疫其他条目。其余 `.size).toBe`(pendingApprovals/cron/FileRunStore/mergeTranscripts 等)都是**本地对象**确定性,无此风险。

### 2.4.5) 🟡 给用户的发现:send_input 续接缺「agent 在跑」并发守卫(你刚 merge 的特性)

> 你 session 期间 merge 的 `send_input 续接`(commit a0b55219)—— 我只修了它的 typecheck 红(私有 snapshot,5ac51235),**没动它的逻辑**(你在迭代中,UX 该怎样由你定)。复核时发现一个并发缺口,留给你判:

- **位置**:`agent.ts` 的 send_input resume 路径(~1045-1062)只检查 session **存在**(registry `entry` 或 on-disk),**不检查 `entry.status === "running"`**。
- **场景**:一个 sub-agent 已转后台仍在 `running`,父 LLM 又 `send_input(sameAgentId)` → 第二次 resume 建**全新 child Engine** 调 `child.run(sessionId=同一childSid)`,两个 Engine 各自 `sessionManager.resume` + 往**同一 transcript 追加**。sub-agent 是独立 spawned Engine,**没有 ChatSession 那层 per-session `active` 锁**(protocol 层的串行化只覆盖顶层会话,不覆盖 sub-agent),故两次 resume 可交错写同一 child transcript → 可能损坏/交错。
- **可达性**:父在背景 agent 没跑完时主动 send_input 即触发,plausible。
- **建议**(你定):resume 前若 `entry?.status === "running"` → 拒绝(「该 agent 仍在运行,等它完成或先 stop」)/ 排队 / 或 interrupt-then-resume。最小止血是拒绝。
- 非我擅自改的原因:这是你在迭代的特性,UX 语义该你拍板;我只标注。

### 2.5) 修复完整性复审(查「只修一半」)

回头审本 session 各修复是否所有同类路径都覆盖:
- **R-1 0o600**:❌ 首轮漏一处 → 已补 engine.persistActiveModel(e56825d6)。settings.json 共 3 个写入点,现全覆盖(见 §2.1 / 记忆 settings-json-three-writers)。
- **cookie 域围栏 cookieDomainMatches**:✅ 完整。全仓仅 `credentials-login/index.ts:241` 一处做手动域过滤(已用安全 matcher);capture/service 其余路径全走 Electron 原生 `cookies.get({domain})`,无 `endsWith` 字符串匹配。
- **非数组 secret 守卫**:✅ 完整。3 个 parse-secret 消费点:index.ts(已修抛错)/ cookie-jar.ts 共享 parser(非数组→`[]`,非破坏性 OK)/ agent-bridge.ts(非数组→jar=[]→`length===0` 在破坏性 restore **前**显式报错,已安全)。唯一会「空 jar 直灌 clear 清空登出」的就是已修的 index.ts。

### 3) 总评

仅 1 个 🔴 真安全 bug(权限链式命令绕过,已修两次补全);其余真问题均为安全卫生/健壮性纵深修。安全 / 并发 / 文件事务 / IO 恢复关键路径**整体扎实**,且关键不变量(stricterDecision / clampMaxTokens / isClientError / unregister 身份)**均已有专门回归测试**。后续连续子系统持续返回干净 = 覆盖面饱和信号。

## 附:晚上「一遍遍找问题」循环建议方向(token 耗尽前反复跑)

1. **代码正确性 bug 扫**(core + desktop):对抗式 review 找空指针/竞态/边界/错误吞没,逐个对抗验证后再记。重点新代码:catalog 写入、cookie capture/inject、plugin 覆盖升级原子性、mobile-remote 鉴权。
2. **§1.1 typecheck 红收口** → 然后每轮跑 `bun run typecheck` 防回归。
3. **§3 测试补全**:按优先级 1→2→3 补,每补一个跑 `bun test <file>`。
4. **§4 文档清理**:每删/归档一份前 grep 代码确认。
5. 每轮产出:改了什么 + 验证输出 + 下一轮入口。琐碎走 main,大改走 worktree。
