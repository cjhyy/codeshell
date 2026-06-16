# UseCredential 工具 + CredentialUseGate 设计

> 2026-06-16 · 凭证模块第二期。第一期(已合 main)做了凭证库存储/UI/MCP 绑定;本期做
> **运行时让 AI/skill 取用凭证**:一个统一的 `UseCredential` deferred 工具(token/link/cookie
> 一个工具,对 AI 只叫「凭证」),取用前过 CredentialUseGate(审批 + 本会话记住 + 全自动开关)。

## 1. 背景与目标

第一期已交付:CredentialStore(token/link 两层库)、凭证页 3 tab、MCP credentialRef 绑定、
cookie-lease 基元(createCookieLease/cleanupLease/sweepStaleLeases)。

**缺口**:AI 跑 yt-dlp/curl 时,没有任何机制取用这些凭证。当前 media-downloader skill 走的是
yt-dlp 自带 `--cookies-from-browser chrome`(读系统真实 Chrome),用不上 codeshell 内置浏览器
(persist:browser 分区)的登录态。本期补这条桥。

**目标**:AI 能"先知道有哪些凭证 → 取用某个 → 拿结果去执行命令",取用前按权限审批。

### 关键约束(架构)

- **Bash 跑在 core 子进程**(agent-server-stdio,经 AgentBridge spawn),与 Electron main 分进程。
- **token/link 在 CredentialStore(磁盘)**,core 能直接读。
- **cookie 只在 Electron main 的 `session.fromPartition("persist:browser")`**,core 读不到,
  必须跨进程向 main 请求。
- core→host 现有回路只有**通知**(StreamEvent / ApprovalRequest)+ 审批的 request/response
  (`requestApprovalFromClient`:notify+requestId→pendingApprovals map→client 答复 resolve)。

### 非目标 (YAGNI)

- 不改 media-downloader skill(老路 `--cookies-from-browser` 还能用;等工具跑通再单独决定)。
- 不做 cookie 值常驻存储(仍是临时 lease,源常驻 persist:browser)。
- 不做凭证自动刷新。

## 2. 对 AI 的接口:`UseCredential`(deferred 工具)

- **deferred**:不常驻,AI 经 ToolSearch 搜出来(MCP 工具同款 name-only 机制)。
- **描述只说「使用一个已存的凭证」**,不暴露 cookie/token/link 内部差异。
- **动态描述**(镜像 `generateVideoToolDefFor(cwd)`,generate-video.ts:174):一个
  `useCredentialToolDefFor(cwd)` 工厂,在描述末尾附当前可用清单
  (`当前可用: my-figma-token (token), cookie: xiaohongshu.com …`),让 AI 一搜出就看到。
- **参数**:`{ id?: string; domain?: string; purpose?: string }`
  - 无参 / 无 id 无 domain → **返回清单**(权威实时源,兜底动态描述的滞后)。
  - `id` → 取 token/link。
  - `domain` → 取 cookie。
  - `purpose` → 给审批文案(可选)。
- **返回(具体结果,按类型)**:
  - 清单:`{ kind: "list", tokens: [{id,label}], links: [{id,label}], cookieDomains: [string] }`(脱敏,无 secret)。
  - token/link:`{ kind: "token", value: "<secret>" }`。
  - cookie:`{ kind: "cookie", cookiesFile: "/tmp/codeshell-cookie-leases/lease-xxx.txt", count: N }`。
- AI 用法:`yt-dlp --cookies <cookiesFile> …` / `curl -H "Authorization: Bearer <value>"`。

## 3. 数据通道(取值)

按类型分流,**两类都照现有 request/response 范式**:

### 3.1 token/link —— core 直读
core 工具内 `new CredentialStore(cwd).resolve(id)?.secret`。无需跨进程。
列清单同理:`listMasked()` + (cookie 域名见 3.2 的 list 分支)。

### 3.2 cookie —— 跨进程向 main 请求(镜像审批回路)
cookie 在 main,core 读不到。**新增一条与审批同构的 host 请求**(不复用审批回路本身——见 §4
全自动档无审批可借,故取值必须独立于审批):

- 协议:`Methods.CredentialRequest`(core→client notify,带 requestId + `{ op: "listDomains" | "lease", domain? }`)
  + client 答复方法 `Methods.CredentialResolve`(`{ requestId, result }`)。
  core 侧 `requestCredentialFromClient()` 完全镜像 `requestApprovalFromClient()`:
  Promise + pendingCredentials map + 超时兜底。
- main 侧 handler:
  - `listDomains` → `listCookieDomains()`(已实现)。
  - `lease` → `createCookieLease(domain)`(已实现)→ 返回 `{ filePath, count }`。
- 清单(§2 的 list 分支)cookieDomains 经此通道的 `listDomains` 取。

> 规范依据:这是把现有审批的 request/response 机制(server.ts:1312)一比一复制成
> credential 通道,而非发明新东西;放在 protocol/types.ts Methods 里与其它方法并列。

## 4. CredentialUseGate(审批 + 三档)

取值**之前**过门(token/link 取值前、cookie lease 前):

- **默认弹审批**:复用 `InteractiveApprovalBackend.requestApproval`,
  文案「AI 想用『<label/domain>』(<purpose>)执行操作,是否允许?」。
- **本会话记住**:选项落 `sessionAllowRules`(内存,关 app 忘),键按
  (凭证 id / cookie 域名),不按工具名(避免一次批准放行无关调用,见 memory
  `project_permission_session_cache`)。
- **全自动开关**:settings 新增 `credentials.autoApprove`(默认 false)。开了直接放行不弹。
  在凭证页或设置里给一个 Switch。
- 拒绝/超时 → 工具返回友好错误,AI 可回退到 `--cookies-from-browser` 或提示用户。

## 5. 清理 & 错误

- cookies.txt:工具调用返回后由「本次工具结束」try/finally 触发 `cleanupLease`;
  叠加 5 分钟超时定时器 + 启动 `sweepStaleLeases`(均已实现)。
  注:lease 路径交给 AI 用于紧接着的命令,清理时机是"本轮工具用完"——简单起见,
  lease 由超时 + 启动 sweep 兜底回收(不强求命令结束即删,因为 core 不知道 AI 何时跑完那条
  yt-dlp);5 分钟 TTL 覆盖正常下载启动窗口。长下载场景下载器已把 cookie 读进内存。
- 凭证不存在 / 域名无 cookie(未登录)/ 审批拒绝 / 超时:各自明确返回。

## 6. 测试 (TDD)

core(`bun test src/`):
1. `requestCredentialFromClient` 协议 round-trip(notify→resolve→超时兜底),镜像审批测试。
2. `UseCredential` 工具:无参=清单;id→token 直读;domain→走 credential 通道取 lease 路径。
3. `useCredentialToolDefFor(cwd)` 动态描述含可用清单(空时回退基础描述)。
4. CredentialUseGate:默认弹审批;本会话记住按 id/域名键且仅内存;autoApprove=true 跳过。

desktop:
5. main `CredentialRequest` handler:listDomains→listCookieDomains;lease→createCookieLease 返回路径。
6. settings autoApprove Switch 渲染+持久化(锁定测试)。

## 7. 分阶段实施

1. **core 协议**:Methods.CredentialRequest/Resolve + requestCredentialFromClient + pendingCredentials(镜像审批)。
2. **core 工具**:UseCredential(无参清单/token 直读/cookie 经通道)+ useCredentialToolDefFor 动态描述 + deferred 注册。
3. **core Gate**:CredentialUseGate(审批+本会话记住+autoApprove 读 settings)。
4. **desktop main**:CredentialRequest handler(复用 listCookieDomains/createCookieLease)。
5. **desktop settings**:autoApprove 开关 UI。

## 8. 复用的现有基础设施

- 审批 request/response 范式:`protocol/server.ts requestApprovalFromClient`(line 1312)+ pendingApprovals。
- 动态工具描述:`generate-video.ts generateVideoToolDefFor(cwd)`(line 174)。
- deferred/ToolSearch:`tool-system/builtin/tool-search.ts`(MCP name-only 机制)。
- 审批后端:`tool-system/permission.ts InteractiveApprovalBackend` + sessionAllowRules。
- cookie 基元:`desktop/src/main/credentials-service.ts`(listCookieDomains/createCookieLease/cleanupLease/sweepStaleLeases,第一期已做)。
- CredentialStore:`core/src/credentials/store.ts`(token/link 两层库 + listMasked + resolve)。
