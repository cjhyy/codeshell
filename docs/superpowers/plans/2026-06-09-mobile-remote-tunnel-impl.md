# 手机遥控「公网隧道模式」实现计划

> 2026-06-09 · 实现计划。落地 spec `2026-06-09-mobile-remote-tunnel-design.md`。
> 范围:Electron main(`packages/desktop/src/main/mobile-remote/`)+ preload + 渲染层 `MobileRemoteSection`。
> 纪律:每个单元 TDD(测试先行),`bun test` 跑 `src/` 不跑 dist;desktop 有独立 `bunx tsc --noEmit` + `bun run build:renderer`,根检查不覆盖。

## 现状锚点(已核实的真实接线)

- `remote-host-manager.ts` `RemoteHostManager`:`start({host,port})`;`host:"lan"` → `resolveLanHost()`,否则按字面绑定;HTTP `createServer` 内仅 `/mobile`、`/health`、404;`WebSocketServer({server, path:"/ws"})`;`createPairingUrl()` 用 `this.started.url` 拼 `/mobile?pairing=`。
- `index.ts`:`mobileRemote = new RemoteHostManager({...})`;IPC `mobileRemote:start` 写死 `{host:"lan",port:0}`;`mobileRemote:stop/status/listDevices/revokeDevice` 已有;退出钩子 `void mobileRemote.stop()`(行 ~1475)。
- `trusted-device-store.ts`:hash 存储 + 持久化 + get-or-create + revoke 的范本(access-passcode 仿其结构)。
- preload `index.ts` 行 584、`types.d.ts` 行 621 是 `mobileRemote` 暴露面。
- UI `AdvancedSections.tsx` `MobileRemoteSection()` 行 1127;start/stop/revoke/QR 已有。

## 复用边界(spec §整体架构)

公网模式只改 3 点:**绑定地址**(lan→127.0.0.1)、**网址来源**(LAN IP→隧道域名)、**在 /mobile、/ws 路由前插一道口令闸门**。配对/可信设备/WS/手机网页 UI 全部沿用。LAN 模式行为零变化(回归保护)。

---

## Task 1 — `cloudflared-binary.ts`(新,纯单元)

只管二进制,无进程、无网络服务。

**接口**
- `binaryPath(): string` — `<userData>/mobile-remote/bin/cloudflared`(由 ctor 注入 baseDir,便于测试)。
- `isInstalled(): boolean` — 文件存在且可执行。
- `ensureBinary(onProgress?: (pct:number)=>void): Promise<string>` — 已存在则跳过;否则按 `process.arch` 选 url(darwin-arm64 / darwin-amd64),`node:https` 下载到 `cloudflared.download` 临时名,校验 200 + 非空,`chmod 0o755`,原子 rename 到最终名;失败删临时文件并抛。
- arch→url 抽成可测纯函数 `cloudflaredDownloadUrl(arch): string`。

**依赖**:`process.arch`、`node:https`、`node:fs`(注入 fs/https 以便 mock,或抽 `download` 为可注入函数)。

**测试**(TDD 先写):
1. 已存在(且可执行)→ `ensureBinary` 不发起下载、返回路径。
2. 下载失败(https 回错/非 200)→ 抛错且不留 `.download` 残文件。
3. `cloudflaredDownloadUrl("arm64")` / `("x64")` 返回对应官方 URL。
4. 成功下载 → 临时名 → rename 到最终名 + chmod 可执行。

## Task 2 — `tunnel-manager.ts`(新,纯单元)

只管隧道进程。

**接口**
- `start(port: number): Promise<{ url: string }>` — `spawn(binaryPath, ["tunnel","--url",`http://127.0.0.1:${port}`])`(spawn 注入以便 mock);监听 stdout/stderr,正则 `https:\/\/[a-z0-9-]+\.trycloudflare\.com` 抓第一个命中即 resolve;15s 未出 URL → kill + reject("隧道启动失败/超时")。
- `stop(): void` — kill 子进程(SIGTERM),清状态。
- 事件:`EventEmitter`,`emit("status", "connected"|"disconnected"|"error", detail?)`。进程 `exit`/`close` 未经 stop → emit `disconnected`(地址作废);spawn error → `error`。**不自动重启**(spec 决策表)。

**依赖**:`node:child_process`(注入)、`cloudflared-binary`(取路径)。超时用注入的 timer / 真实 setTimeout 均可,测试喂 fake child。

**测试**:
1. 喂模拟 stdout 含 `https://foo-bar.trycloudflare.com` → `start` resolve 该 URL。
2. 超时无 URL → reject 且子进程被 kill。
3. 启动后子进程 exit → emit `disconnected`。
4. `stop()` → kill 调用 + 不再 emit。

## Task 3 — `access-passcode.ts`(新,纯单元)

只管访问口令(仿 trusted-device-store 结构)。存 `<userData>/mobile-remote/access.json`。

**接口**
- `isSet(): boolean`。
- `set(passcode: string): void` — 存 `scrypt`/`sha256+salt` hash,**不存明文**;重设口令使所有旧"记住"凭证失效(轮换 server secret)。
- `verify(passcode: string): string | null` — 正确返回新签发的"记住"凭证 token(HMAC over server secret),错误返回 null + 记一次失败。
- `verifyToken(token: string): boolean` — 校验记住凭证(签名 + 未因改口令失效)。
- `gate(req, res): boolean` — HTTP 层闸门:读 cookie/header 里的记住凭证或一次性口令参数,放行返回 true;否则写 401/挑战页返回 false。
- 速率限制:连续输错 N(=5)次 → 锁定 M(=60s)秒,锁定期内 `verify` 直接拒。锁定窗口用注入的 `now()` 以便测试。

**测试**:
1. `set` 后 access.json 不含明文口令(只 hash + salt)。
2. 错误口令 `verify` → null。
3. 正确口令 `verify` → 非空 token,`verifyToken(token)` → true。
4. 改口令后旧 token `verifyToken` → false。
5. 连错 5 次 → 第 6 次即便口令对也被锁定;过锁定窗口后恢复。

## Task 4 — `remote-host-manager.ts`(改)

新增 mode 与口令闸门;LAN 行为不变。

- `RemoteHostStartOptions` 加 `mode?: "lan" | "tunnel"`(默认 lan);`passcode?: AccessPasscode`(tunnel 模式注入)。
- tunnel 模式:`bindHost = "127.0.0.1"`(显式,不走 resolveLanHost)。
- HTTP `createServer` 回调:**在 `/mobile`、`/health` 之外、命中前**,若有 passcode 且 `!passcode.gate(req,res)` → 直接返回(闸门已写响应)。`/ws` 升级前同样校验(WS 握手读 cookie/query 凭证;未过 → 拒绝升级)。
- `createPairingUrl()` 不变(它用 `this.started.url`;tunnel 模式由 index.ts 用隧道域名重写 base —— 见 Task 5;或给 manager 加 `setPublicBaseUrl(url)` 让 pairing 用隧道域名)。**决定:加 `setPublicBaseUrl(url?)`,createPairingUrl 优先用它。** 干净、可测。

**测试**:
1. `mode:"tunnel"` → 绑 `127.0.0.1`(status().host)。
2. 有 passcode 且无凭证 → `/mobile` 请求被闸门挡(401),WS 升级被拒。
3. 有凭证 → 放行,配对/auth 流程不变。
4. `mode:"lan"`(或默认)→ 行为与现状完全一致(回归:绑 LAN、无闸门)。
5. `setPublicBaseUrl` → `createPairingUrl().url` 用隧道域名。

## Task 5 — `index.ts`(改,IPC 编排)

- `mobileRemote:start` 接受 `{ mode }`。lan 分支 = 现状。tunnel 分支:
  1. `accessPasscode.isSet()` 否 → 抛错(UI 禁用入口兜底)。
  2. `cloudflaredBinary.ensureBinary()`(若 UI 已单独下载则秒过)。
  3. `mobileRemote.start({mode:"tunnel", port:0, passcode: accessPasscode})` → 绑 127.0.0.1。
  4. `tunnelManager.start(started.port)` → 拿 `https://xxx.trycloudflare.com`。
  5. `mobileRemote.setPublicBaseUrl(tunnelUrl)`;`createPairingUrl()` → 用隧道域名。
  6. tunnel `status` 事件 → `webContents.send("mobileRemote:tunnelStatus", ...)`;`disconnected` → 地址作废,通知 UI。
  7. 失败(ensureBinary/抓 URL 超时)→ 停掉、抛友好错误、回退未开启。
- 新 IPC:`mobileRemote:downloadCloudflared`(进度经 `webContents.send` 回传)、`mobileRemote:setPasscode`、`mobileRemote:passcodeStatus`(isSet)、`mobileRemote:tunnelStatus`(查当前)。
- `new AccessPasscode(...)`、`new CloudflaredBinary(...)`、`new TunnelManager(...)` 实例化(userData 路径)。
- 退出钩子:`tunnelManager.stop()` 一并 kill cloudflared(防孤儿),加到现有 `void mobileRemote.stop()` 旁。

(index.ts 这层主要是接线,核心逻辑已被 1–4 单测覆盖;此处不强求新单测,靠手动真机验证。)

## Task 6 — preload + `MobileRemoteSection.tsx`(改,UI)

**preload**(`index.ts` 行 584 + `types.d.ts` 行 621):
- `start(opts?: { mode?: "lan"|"tunnel" })`。
- 新增 `downloadCloudflared(): Promise<void>` + `onDownloadProgress(cb)`、`setPasscode(p)`、`passcodeStatus()`、`onTunnelStatus(cb)`、`cloudflaredInstalled()`。

**UI**(`MobileRemoteSection`,遵守 desktop CLAUDE.md:shadcn/ui + Tailwind,禁原生控件;用 DialogProvider hooks + toast):
- 模式切换:局域网 / 公网(隧道)—— 用 shadcn 控件(simple-select 或 Tabs)。
- 公网模式:访问口令输入(`Input` type=password)+「设置口令」;未设口令 → 禁用「开启公网」并提示。
- 未装 cloudflared → 显示「下载 cloudflared」`Button` + 进度(进度条/百分比)。
- 开启后用隧道 URL 生成二维码(复用现有 QRCode 逻辑,数据源换成隧道 pairingUrl)。
- 隧道状态行:connected / disconnected(已断开→提示地址作废,需重新开启)。
- LAN 模式 UI 路径保持现状不变。

**验证(desktop 独立)**:`cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`。

---

## 执行顺序与并行度

- Task 1 / 2 / 3 互相独立(三个新纯单元)→ 可并行。
- Task 4 依赖 3(注入 passcode 类型);可与 1/2 并行起步,落地前需 3 的接口定稿。
- Task 5 依赖 1–4 全部。
- Task 6 依赖 5 的 preload 形态。

worktree 内单 subagent 串行做 1→6 最稳(避免同文件 index.ts/preload 冲突);1/2/3 若并行则各自独立新文件不冲突。

## 验收门槛(claim 完成前必须有证据)

- `bun test packages/desktop/src/main/mobile-remote/` 全绿(含新 4 个 *.test.ts + 现有回归)。
- `cd packages/desktop && bunx tsc --noEmit` 零错。
- `cd packages/desktop && bun run build:renderer` 成功。
- LAN 模式现有测试不被破坏。
- 真机扫码验证(公网):由主持人(非 subagent)亲自做 —— 4G 下手机浏览器零安装打开隧道 URL → 过口令 → 配对 → 遥控生效;关 codeshell 后地址失效。
