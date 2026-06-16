# UseCredential 工具 + CredentialUseGate 设计

> 2026-06-16 · 凭证模块第二期。第一期(已合 main)做了凭证库存储/UI/MCP 绑定;本期做
> **运行时让 AI/skill 取用凭证**:一个统一的 `UseCredential` deferred 工具(token/link/cookie
> 一个工具,对 AI 只叫「凭证」),取用前过 CredentialUseGate(默认问 + 本会话记住 + 全自动开关)。
>
> **重大修订(2026-06-16,brainstorm 中)**:cookie 从「现抓 persist:browser + lease」改为
> **具名 cookie 凭证**(进 CredentialStore,跟 token/link 同构)。原因:persist:browser 分区里
> 全是逛街攒的匿名/噪声 cookie,`listCookieDomains` 根本分不清哪些是登录态。改成用户**主动按域
> 拓取存成一条具名凭证**后:列表干净、三类凭证统一、取值不用跨进程(值已在 CredentialStore)。
>
> **二次修订(2026-06-17,brainstorm 中):合并「多账号 cookie」需求。** 真实场景:每天用多个
> 小红书账号轮着拉内容,需要**同一平台存多个账号、都长期保活、按账号取用**。在本稿基础上扩两点:
> ① cookie 凭证从「一域一条」改为**同一域可存多条具名账号**(id = 平台+账号名,不再 = 域名);
> ② 加一个**「切换到浏览器」动作**——把某账号的 cookie 导回 `persist:browser` 覆盖当前登录态,
> 让你在内置浏览器里以该账号身份浏览。AI 轮换走 `UseCredential`(喂工具,不切浏览器)。
>
> **关键决策记录(brainstorm)**:
> - **存范围 = 按平台主域拓取(含子域),不存全量分区。** 一度想"全量存图省事",但 `persist:browser`
>   是所有站共用一个分区,全量会把 YouTube/百度的 cookie 混进"小红书-账号A",切换时清空再灌回会
>   连带回滚/覆盖无关站点的登录态,喂工具时还泄漏。故用 `getCookiesForDomain(domain)`(Electron
>   后缀匹配,自动含该平台所有子域)——平台内"全量"不漏会话 cookie,跨平台隔离。
> - **一条凭证绑一个主域(方案 X,YAGNI)。** 99% 平台单域够用;某平台登录态跨域(SSO)漏了再支持多域。
> - **切换到浏览器先清空再灌入。** 否则残留 cookie 与导回的打架。本期只管 cookie,**不含 localStorage**
>   (很多站把配置存 localStorage,已知局限,后续优化 —— 见 §11)。

## 1. 背景与目标

第一期已交付:CredentialStore(token/link 两层库)、凭证页 3 tab、MCP credentialRef 绑定、
cookie-lease 基元(formatNetscapeCookies/getCookiesForDomain/createCookieLease 等)。

**缺口**:AI 跑 yt-dlp/curl 时没有机制取用这些凭证;且第一期 Cookie tab 列「已登录域名」实际列出
的是分区里所有噪声域名,不可用。本期补取用桥 + 修 cookie 形态。

**目标**:AI 能"先知道有哪些凭证 → 取用某个 → 拿结果去执行命令",取用前按权限审批。

### 架构方向约束(重要,见 memory `project_core_minimal_harness_business_layer`)

用户拍板:**core 保持最小 harness,业务逻辑后续外移到 core 外的业务层**。凭证是业务逻辑。
- 本期 UseCredential 工具 + Gate **暂放 core**(能跑、不阻塞),但必须**边界清晰、可整块拎出**:
  集中在 `core/src/credentials/` 下(工具 + gate 都放这,不散进 tool-system 各处),
  对 core 其它部分只通过既有接口(ToolDefinition 注册、InteractiveApprovalBackend)耦合。
- 目标:后续 core 简化时,这块能整体迁到业务层而无需大改。

### 非目标 (YAGNI)

- 不改 media-downloader skill(老路 `--cookies-from-browser` 还能用;等工具跑通再单独决定)。
- 不做跨进程 CredentialRequest 通道(cookie 既已存库,core 直读,无需向 main 请求取值)。
- 不做 cookie lease 三层清理重机制(取用时就地写临时 cookies.txt、用完删即可)。
- 不做凭证自动刷新(cookie 过期 → UI 上「刷新」重拓一次)。

## 2. cookie 形态变更:具名 cookie 凭证(支持同域多账号)

- `CredentialType` 增加 `"cookie"`(原 `"token" | "link"` → `"token" | "link" | "cookie"`)。
- cookie 凭证的 `secret` = 序列化的 cookie jar(JSON,`ElectronCookieLike[]`)。
- **id ≠ 域名**(关键:支持同域多账号)。id = `${platform}__${slug(label)}`,例:
  `xiaohongshu__accountA` / `xiaohongshu__accountB` / `youtube__main`。同一 `meta.domain` 下可有任意多条。
  ```jsonc
  {
    "id": "xiaohongshu__accountA",
    "type": "cookie",
    "label": "账号A",
    "meta": { "platform": "xiaohongshu", "domain": "xiaohongshu.com" },
    "secret": "<getCookiesForDomain('xiaohongshu.com') 的 jar JSON>"
  }
  ```
- **存**:凭证页 Cookie tab 改为:输**平台/域名**(如 `xiaohongshu.com`)+ **账号名**(如 `账号A`)→
  main `getCookiesForDomain(domain)`(已实现,Electron 后缀匹配自动含所有子域)拓**该域**cookie →
  经 IPC 存成一条 cookie 凭证。**按域拓,不存全量分区**(否则混入 YouTube/百度,见首部决策记录)。
- **刷新/重拓**:一个「重拓」按钮,重新 `getCookiesForDomain` 覆盖该凭证的 jar(处理过期/重登后更新)。
- **切换到浏览器(本期新增动作,见 §5.5)**:把该凭证的 jar 导回 `persist:browser` 覆盖当前登录态。
- **列**:Cookie tab **按 platform 分组**列已存的 cookie 凭证(label + domain + cookie 数,掩码不显值)。

> 跨进程只剩**存/切换那一刻**的拓取/导回(本就在 main、UI 触发、复用 getCookiesForDomain)。
> AI 取用时 cookie 值已在 CredentialStore,core 直读 —— 跟 token/link 完全一致。

## 3. 对 AI 的接口:`UseCredential`(deferred 工具)

- **deferred**:不常驻,AI 经 ToolSearch 搜出(MCP 工具同款 name-only 机制)。
- **描述只说「使用一个已存的凭证」**,不暴露 cookie/token/link 内部差异。
- **动态描述**(镜像 `generateVideoToolDefFor(cwd)`,generate-video.ts:174):
  `useCredentialToolDefFor(cwd)` 工厂在描述末尾附当前可用清单
  (`当前可用: my-figma-token (token), xhs (cookie) …`),AI 一搜出就看到。空时回退基础描述。
- **参数**:`{ id?: string; purpose?: string }`
  - 无 id → **返回清单**(权威实时源,兜底动态描述的滞后)。
  - `id` → 取该凭证(按 type 决定返回形态)。
  - `purpose` → 审批文案用(可选)。
- **返回(具体结果)**:
  - 清单:`{ kind: "list", credentials: [{ id, label, type }] }`(脱敏,无 secret)。
  - token/link:`{ kind: "value", value: "<secret>" }`。
  - cookie:`{ kind: "cookie", cookiesFile: "<临时 cookies.txt 路径>", count: N }`。
- AI 用法:`yt-dlp --cookies <cookiesFile>` / `curl -H "Authorization: Bearer <value>"`。

> 注意 cookie 也用同一个 `id` 参数(不再有 domain 分支)——三类凭证对 AI 完全同构。

## 4. 取值(全部 core 直读,无跨进程)

`UseCredential` 在 core 工具内:
- 列清单:`new CredentialStore(cwd).listMasked()` → 映射成 `{id,label,type}`。
- token/link:`store.resolve(id).secret` → 直接返回值。
- cookie:`store.resolve(id)` → 拿 cookie jar → `formatNetscapeCookies(jar)`(已实现)→ 写一个
  临时文件(`os.tmpdir()/codeshell-cookie-<id>-<pid>.txt`,0600)→ 返回路径。
  **就地写临时文件、不引入 lease 对象/超时定时器**;清理靠进程退出 + 一个轻量启动 sweep
  (沿用 sweepStaleLeases 扫同目录即可,不新增机制)。

## 5. CredentialUseGate(轻审批,三档)

取值**之前**过门:
- **默认弹审批**:复用 `InteractiveApprovalBackend.requestApproval`,
  文案「AI 想用『<label>』(<purpose>),是否允许?」。
- **本会话记住**:落 `sessionAllowRules`(内存,关 app 忘),键按**凭证 id**
  (不按工具名,避免一次批准放行无关调用,见 memory `project_permission_session_cache`)。
- **全自动开关**:settings `credentials.autoApprove`(默认 false)。开了直接放行不弹。
  凭证页给一个 Switch。
- 拒绝/超时 → 工具返回友好错误,AI 可回退 `--cookies-from-browser` 或提示用户。

## 5.5 切换到浏览器(导回覆盖)—— 多账号需求新增,**不走 AI 审批门**

cookie 凭证除了"喂工具",还要能**把某账号的登录态切回内置浏览器**,让用户以该账号身份浏览。

- **谁触发**:用户在 Cookie tab 手动点 cookie 凭证上的 **[切换]** 按钮。**不是 AI 触发**,因此
  **不过 CredentialUseGate**(那道门是给 AI 取值用的)——只一个 UI 二次确认弹窗(`useConfirm`):
  「将用『账号A』覆盖当前浏览器登录态?」。
- **实现**(main 进程,新 IPC `credentials:restoreCookieToBrowser`):
  ```
  restoreCookieToBrowser(id):
    sess = session.fromPartition("persist:browser")
    await sess.clearStorageData({ storages: ['cookies'] })   // 先清空(决策:避免残留打架)
    for c of store.resolve(id).jar:
       await sess.cookies.set({ url: urlFor(c), name, value, domain, path, secure, expirationDate, ... })
    → 广播事件通知浏览器面板刷新当前 tab = 切换成该账号身份
  ```
  注意:`clearStorageData({ storages: ['cookies'] })` 清的是整分区 cookie。这是有意的——"切换账号"
  语义就是把浏览器换成该账号的干净状态。本期只清 cookie,不动 localStorage(§11 已知局限)。
- **边界**:导回是用户对自己浏览器的操作,无敏感外泄,故只需 UI 确认,不进 core 审批后端。

## 5.6 两条使用路径(回答「自动 vs 配好才能用」)

| 路径 | 谁触发 | 走什么 | 门控 |
|---|---|---|---|
| **切换到浏览器**(人工浏览) | 用户点 [切换] | main `restoreCookieToBrowser` | 仅 UI 二次确认,**无 AI 审批** |
| **喂工具**(AI 抓取/下载) | AI 调 `UseCredential` | core 直读 jar → 写 cookies.txt | **CredentialUseGate 三档**(默认问/会话记住/全自动) |

> **LLM 轮换**走第二条:AI `UseCredential` 无参拿 list(看到 `xiaohongshu__accountA/B/C`)→ 逐个取 →
> 各得一份 cookies.txt → 轮着喂抓取命令,**不切浏览器**。账号池/自动调度**不在本期**(YAGNI,
> 由 AI 在任务里自行轮换;将来要"防限流自动轮换"再单独设计)。

## 6. 错误处理

- 凭证不存在 / 审批拒绝 / 超时:各自明确返回。
- cookie jar 为空(存的时候那域没 cookie):存的时候就提示「该域无 cookie,请先在内置浏览器登录」。
- cookie 过期:取用不报错(yt-dlp 自己会 403);UI 引导「重拓」。

## 7. 测试 (TDD)

core(`bun test src/`):
1. `UseCredential` 无参 = 清单(脱敏,带 type)。
2. id→token/link 返回 value;id→cookie 写出 cookies.txt 且 `formatNetscapeCookies` 格式正确。
3. `useCredentialToolDefFor(cwd)` 动态描述含可用清单;空时回退基础描述。
4. CredentialUseGate:默认弹审批;本会话记住按 id 键且仅内存;autoApprove=true 跳过。
5. CredentialStore 支持 `"cookie"` type round-trip(jar 存读)。

desktop:
6. Cookie tab 新流程:输**域名 + 账号名** → 拓取(getCookiesForDomain)→ 存成 cookie 凭证
   (id=平台+账号名,**同域多条不覆盖**);**按 platform 分组列**已存项。
7. settings autoApprove Switch 渲染+持久化(锁定测试)。
8. **切换到浏览器**:点 [切换] → `useConfirm` → `restoreCookieToBrowser` 清空+灌回 → 广播刷新
   (验证清空调用 + cookies.set 逐条调用 + 刷新事件;Electron session mock)。

## 8. 分阶段实施

1. **core CredentialType 加 "cookie"** + store round-trip 测试。
2. **core UseCredential 工具**(`core/src/credentials/use-credential-tool.ts`):无参清单/直读/cookie 就地物化 + 动态描述 + deferred 注册。
3. **core CredentialUseGate**(`core/src/credentials/use-gate.ts`):审批+本会话记住+autoApprove 读 settings。
4. **desktop Cookie tab 重做**:输**域名+账号名**→拓取→存凭证(同域多条)+ **按 platform 分组列** + 重拓按钮。
5. **desktop 切换到浏览器**:main `restoreCookieToBrowser`(IPC + preload + clearStorageData/cookies.set + 刷新广播)+ Cookie tab [切换] 按钮(useConfirm/useToast)。
6. **desktop settings**:autoApprove 开关 UI。

> 阶段 2、3 集中在 `core/src/credentials/` 下,与 core 其余部分只经 ToolDefinition/审批后端耦合,
> 满足§1 的「可整块外移」约束。

## 9. 复用的现有基础设施

- 动态工具描述:`generate-video.ts generateVideoToolDefFor(cwd)`(line 174)。
- deferred/ToolSearch:`tool-system/builtin/tool-search.ts`。
- 审批后端:`tool-system/permission.ts InteractiveApprovalBackend` + sessionAllowRules。
- cookie 格式/拓取:`desktop/src/main/credentials-service.ts`(formatNetscapeCookies / getCookiesForDomain / sweepStaleLeases,第一期已做;createCookieLease/cleanupLease 不再用于取值,可保留备用或删)。
- CredentialStore:`core/src/credentials/store.ts`(两层库 + listMasked + resolve;本期加 cookie type)。

## 10. 第一期遗留的清理

- Cookie tab 从「列已登录域名 + 预览数量」改为本设计的「拓取存凭证」流程。
- `credentials:cookieDomains` / `credentials:cookiePreview` IPC:cookiePreview 可废;
  cookieDomains 若不再用于"列噪声域名"也可废(存凭证时用 getCookiesForDomain 直接按用户输入的域拓)。

## 11. 已知局限 / 未来优化(本期不做)

- **localStorage 不纳入快照**:cookie 凭证只存/导回 cookie。很多站把部分登录态或配置存在
  localStorage(用户已指出),本期切换可能对这类站不完整。后续看是否把 localStorage 一并纳入
  快照与导回。
- **单域绑定(方案 X)**:一条凭证只拓一个主域。登录态跨域(SSO 域)的平台可能漏 cookie;
  发现后再支持"一条凭证多域拓取"。
- **AI 轮换由 AI 自行调度**:不做账号池/防限流自动轮换。将来要自动轮换再单独设计。
- **cookie 不自动刷新**:过期靠用户点「重拓」重登后覆盖 jar。
