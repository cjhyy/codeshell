# 手机遥控「公网隧道模式」设计

> 2026-06-09 · 设计文档。在现有局域网「手机遥控」之上增加一个公网模式:手机浏览器零安装,经 Cloudflare 临时隧道遥控桌面。

## 与既有调研的关系(知情决策)

`2026-06-07-remote-connectivity-research.md` 系统对比了 5 种远程方案,结论是:
- **推荐 Tailscale(方案 C)**:跨网最安全、CodeShell 几乎零改动;
- **将 Cloudflare Tunnel(方案 D)列为"安全风险最高、不推荐作为默认"**,理由是把「能远程跑命令的控制面」映射到公网 URL,扫描/爆破攻击面大;并立红线"不裸 ws 跨公网"。

**本设计仍选择方案 D(Cloudflare 隧道)**,这是在一个硬约束下的知情选择:

> **硬约束:手机端零安装。** 用户明确要求手机不装任何 app、打开浏览器输网址即用。只有隧道方案满足;Tailscale 要求手机装客户端,违背该约束。

为对冲调研点名的风险,本设计强制叠加以下措施(见「安全」一节):访问口令必设 + 口令校验速率限制 + 可信设备/撤销真正生效 + 传输强制 wss(隧道 https 自动升级) + 临时随机域名进程级短寿命。

**补充论据**:现有的「可信设备 + 撤销」机制在 Tailscale 方案下会被 Tailscale 的设备授权架空(成为摆设);只有在隧道方案下,这套机制才真正承担守门职责——撤销一台设备,它下次必须重新过口令 + 配对。

## 目标

在现有局域网「手机遥控」之外,增加一个「公网(隧道)」模式开关。开启后:
- 手机在任意网络(4G/异地 Wi-Fi)下,浏览器零安装打开一个网址即可遥控;
- 底层走 Cloudflare 临时隧道(`trycloudflare.com`);
- codeshell 自动管理 `cloudflared` 二进制与进程;
- 公网入口由一道访问口令守卫,口令在手机首次输对后被记住、以后免输。

## 已确定的决策

| 决策点 | 结论 |
|--------|------|
| cloudflared 管理 | codeshell 自动拉起,作为子进程托管(进程随 codeshell 生命周期) |
| 没装 cloudflared 时 | UI 显示「下载 cloudflared」按钮,点击后下载 |
| 安装方式 | 下载官方二进制(按 `process.arch` 选 darwin-arm64 / darwin-amd64),放 `<userData>/mobile-remote/bin/` |
| 隧道类型 | 临时隧道(`cloudflared tunnel --url`),不登录 Cloudflare、不需域名 |
| 地址寿命 | 进程级。codeshell 开着且开关开着则有效;关闭/退出则失效;每次重开是新随机地址,二维码重新生成 |
| 公网安全 | codeshell 自带访问口令(必设),不依赖 Cloudflare Access |
| 口令记忆 | 手机首次输对后,浏览器存凭证、以后免输;换手机/清浏览器数据/改口令时才重输 |
| 隧道崩溃 | 不自动重启(避免静默换地址却不更新二维码);发"已断开"状态给 UI,地址作废 |

## 整体架构与数据流

```
[设置页·手机遥控]  切换:○ 局域网   ● 公网(隧道)
        │
   开启公网时:
     1. 检测 <userData>/mobile-remote/bin/cloudflared 是否存在
        └ 不存在 → 显示「下载 cloudflared」按钮 → 下载对应架构二进制
     2. 校验已设访问口令(未设则禁止开启)
     3. 启动 RemoteHostManager,host = 127.0.0.1(而非 LAN IP)
     4. 拉起 cloudflared tunnel --url http://127.0.0.1:<port>
     5. 解析 stdout 抓 https://xxx.trycloudflare.com
     6. 用隧道域名生成配对 URL + 二维码
        │
   手机浏览器打开 https://xxx.trycloudflare.com/mobile?pairing=<token>
        └ ① 访问口令闸门(记住后免输)
          → ② 原有配对 token(一次性,10 分钟)
          → ③ 可信设备(永久记忆,可撤销)
          → WebSocket(隧道 https 自动升级为 wss)
```

**复用现状**:配对、可信设备、WebSocket、手机网页 UI 全部沿用现有代码。公网模式只改 3 点:绑定地址(LAN→127.0.0.1)、网址来源(LAN IP→隧道域名)、在路由前插入一道口令闸门。

## 组件拆分(每个单元单一职责)

新增尽量隔离成独立单元,不污染现有局域网逻辑。

1. **`cloudflared-binary.ts`(新)** — 只管二进制。
   - 职责:检测是否存在、下载对应架构官方二进制、校验可执行权限。
   - 接口:`isInstalled()`、`binaryPath()`、`ensureBinary(onProgress?) → Promise<string>`。
   - 依赖:`process.arch`、`node:https`(下载)、`node:fs`。

2. **`tunnel-manager.ts`(新)** — 只管隧道进程。
   - 职责:`spawn(cloudflared, ["tunnel","--url",...])`、从 stdout 正则抓 `https://*.trycloudflare.com`、超时处理、进程退出/崩溃事件、`stop()` kill。
   - 接口:`start(port) → Promise<{ url }>`、`stop()`、状态事件(`connected` / `disconnected` / `error`)。
   - 依赖:`node:child_process`、cloudflared-binary。

3. **`access-passcode.ts`(新)** — 只管访问口令。
   - 职责:设置/校验口令(存 hash,不存明文)、签发&校验"记住"凭证、HTTP 层闸门、失败速率限制。
   - 接口:`isSet()`、`set(passcode)`、`verify(passcode) → token | null`、`verifyToken(token)`、`gate(req,res) → boolean`。
   - 凭证可复用现有可信设备存储的同类思路(hash + 持久化)。
   - 存储:`<userData>/mobile-remote/access.json`。

4. **`remote-host-manager.ts`(改)** — 新增 `mode: "lan" | "tunnel"`。
   - tunnel 模式 host 传 `127.0.0.1`;HTTP 路由在 `/mobile`、`/ws` 之前插入口令闸门校验;LAN 模式行为完全不变。

5. **`index.ts`(改,Electron main)** — IPC 编排。
   - `mobileRemote:start` 接受 `{ mode }` 参数;
   - 新增 `mobileRemote:downloadCloudflared`(带进度回传)、`mobileRemote:setPasscode`、`mobileRemote:tunnelStatus`;
   - tunnel 模式编排:ensureBinary → 校验口令 → start(host 127.0.0.1) → tunnel.start → 用隧道域名生成 pairing;
   - `app` 退出钩子确保 kill cloudflared 子进程(防孤儿)。

6. **`AdvancedSections.tsx`(改,`MobileRemoteSection`)** — UI。
   - 模式切换(局域网 / 公网);访问口令输入(未设禁止开公网);未装时显示「下载 cloudflared」按钮 + 进度;用隧道 URL 生成二维码;显示隧道连接状态。

依赖方向单一:UI → IPC → RemoteHostManager → (TunnelManager, CloudflaredBinary, AccessPasscode)。各单元可独立测试。

## 安全(对冲调研点名的风险)

1. **访问口令必设** —— 公网总闸,挡住"陌生人撞到隧道域名"。未设口令时 IPC 层拒绝开启公网。
2. **口令校验速率限制** —— 连续输错 N 次锁定一段时间,回应调研"被扫描/爆破"风险。
3. **可信设备 + 撤销真正生效** —— 公网模式下作为第二/第三道门;撤销一台设备,其下次必须重新过口令 + 配对。
4. **公网段强制 wss** —— 手机到 Cloudflare 边缘是 https/wss(由 Cloudflare 终结 TLS),满足调研红线"不裸 ws 跨公网"。cloudflared 解密后以 http/ws 转发到本机 `127.0.0.1:<port>`——这一跳仅限本机回环,不经网络,可接受。手机网页 `location.origin.replace(/^http/,'ws')` 在 https 域名下自动得到 `wss`,无需改动。
5. **临时随机域名 + 进程级短寿命** —— 关闭即失效、每次重开换地址,缩小攻击窗口。
6. **不绕过桌面权限/审批** —— 手机只是另一个前端,工具审批仍走桌面端原有同一套。

## 错误处理与边界

- **下载失败**(断网/源不可达):按钮回到可重试态,提示具体错误;下载到临时名,校验通过再改名,不留半截文件。
- **cloudflared 启动失败 / 抓不到域名**(如 15s 超时未等到 URL):停掉进程,UI 报"隧道启动失败",回退未开启态。
- **隧道进程中途崩溃**:发"已断开"状态给 UI,地址作废;不自动无限重启。
- **关闭 codeshell**:`app` 退出钩子 kill cloudflared 子进程,不留孤儿。
- **口令未设就开公网**:IPC 拒绝,UI 禁用开启按钮。
- **localhost 绑定校验**:tunnel 模式确认服务真绑在 127.0.0.1,否则 cloudflared 连不上。

## 测试策略

- **cloudflared-binary**:mock fs/下载,测"已存在则跳过下载""下载失败不留残文件""按 arch 选 arm64/amd64"。
- **tunnel-manager**:mock 子进程,喂模拟 stdout,测"正确抓出 trycloudflare 域名""超时未出 URL 则失败""崩溃发 disconnected 事件"。
- **access-passcode**:测"hash 存储不存明文""错误口令拒绝""正确放行并签发记住凭证""速率限制锁定"。
- **remote-host-manager**:测"tunnel 模式绑 127.0.0.1""口令闸门在 /mobile、/ws 路由前生效""lan 模式行为不变(回归)"。
- 现有局域网测试不应被破坏。

## 不做(YAGNI)

- 固定命名隧道 / 自定义域名 / Cloudflare Access(需登录+域名,与"零配置一个开关"冲突)。
- Tailscale / mDNS(另一调研方向,不在本 spec)。
- 隧道自动重连(明确不做,见决策表)。
- Homebrew 安装路径(只走官方二进制下载)。
