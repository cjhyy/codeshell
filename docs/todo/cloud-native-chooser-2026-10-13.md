# 原生 Cloud 项目选择器验收

范围：生产 Desktop Main、preload、React 选择器和原生管理窗口，连接当前真实
ProjectControlServer。Account HTTP/authority、Runtime provider 和远端 HTML 为私有
受控 fixture；真实 Services 双 CA HTTPS 消费另见
[Main/Services 回执](cloud-main-services-https-delivery.md)。此项不代替六 Panel 的
24 组合业务、真实 GitHub、Docker、实体手机、正式安装包或目标部署。

## 已执行

- 集成产品基线 `3a99c376facd8dd7130482515135b825211fade3` 包含恢复耐久性、
  controller marker lease、Main/Services HTTPS 与最新主线。
- workspace 和 Desktop 生产构建、全部 workspace 类型检查、四个受影响脚本
  ESLint/Prettier 通过。
- `node packages/desktop/scripts/e2e-cloud-workbench.mjs --server-only`：真实 Node
  完成合成账号登录、精确 HTTP 201/五字段票据、真实 Server 单次兑换、项目创建、
  启动/停止。主进程收到 child close/exit 0；监听器、socket、运行实例归零后才删除
  私有 HOME。此模式未启动 Electron，不能记为原生界面通过。
- `--server-only --fail-after-ready`：实际 Server ready 后注入准备失败；parent exit 1，
  owned Server exit 0，监听器/socket/runtime 归零，失败 HOME 先保留供核验，确认
  对应 PID 已退出后由检查者删除。没有启动 Main 或调用 Keychain。
- 实际 `closeApp` 函数的受控盘点拒绝、盘点超时、关闭拒绝和正常四条路径通过：
  盘点失败仍尝试关闭，关闭失败仍核验已知 PID；这不是原生 Electron 故障回执。
- 独立审查实际 Bun splitting 产物：静态闭包仅 Node builtins，Core 在 guard 安装后
  动态导入。生成的 Main bootstrap 通过实际 Node 语法检查；生产 Main 动态导入前
  安装 Node/native net guard 和 ready/session hook。Main 保持在 ready 前注册协议，
  较早的 ready hook 安装 defaultSession 限制并执行 Chromium 负探针；每个产品窗口的
  session 也在创建时安装限制。原生 gate 必须确认全部负探针回执。
  ESM 入口仅 await 生产 Main 导入，ready 探针由启动后的实际 Main evaluate 等待，
  避免顶层等待 ready 阻塞初始化；顺序遵循锁定版
  [Electron ESM 合同](https://github.com/electron/electron/blob/v33.4.11/docs/tutorial/esm.md)。

## Linux CI 实际失败与修复

`1e5d5876` 的 run `38277641579` / job `114906922457` 未通过原生 chooser；
日志保留在 `/tmp/codeshell-cloud-native-chooser-ci-38277641579.log`。定位到两处具体问题：

- Electron 的 `net.fetch` 转发到 defaultSession，后者在调用时读取当前 `net.request`；
  因此固定外部负探针先被 native wrapper 拒绝，未到 Chromium webRequest。
  首次修复私有保存原始 fetch 仍不足：run `38279860879` 实际栈确认它仍进入已包装的
  request，日志为 `/tmp/codeshell-cloud-native-chooser-ci-38279860879.log`。
  生成入口现改为包装前私有捕获原始 `net.request` 工厂，只请求一次固定的
  `https://external.invalid/chooser-guard-probe`，指定 defaultSession、omit credentials
  和拒绝重定向。该工厂直接构造 ClientRequest，不再经过 fetch 的动态查找；依据锁定版
  [net 实现](https://github.com/electron/electron/blob/v33.4.11/lib/browser/api/net.ts) 和
  [Session 实现](https://github.com/electron/electron/blob/v33.4.11/lib/browser/api/session.ts)。
  defaultSession 限制先安装，必须得到 `net::ERR_BLOCKED_BY_CLIENT` 且拦截计数精确为 1；
  任意响应、其他错误或 5 秒无结果都失败，finally 清 timer 并 abort。产品
  `net.request/fetch` 的精确 Cloud origin 限制保持不变，没有另开 probe 窗口、暂时替换
  wrapper 或扩大产品请求范围。
  [ClientRequest 实现](https://github.com/electron/electron/blob/v33.4.11/lib/common/api/net-client-request.ts)
  在启动 URLLoader 后完成 Writable；其 close 可能早于网络错误，所以 close 不充当探针结果。
- Playwright 在 `app.close()` 后销毁内部对象，再取 `app.process()` 会抛出 `_object`
  错误。两次实际 launch 返回后立即保存真实 ChildProcess 和 PID，关闭及退出核验只用
  已保存句柄；关闭失败后的重试也不再重新查 Playwright 进程。退出未确认仍保留 HOME。

本轮本地验证不启动 Electron：旧基线实际 `closeApp`/退出方法受控执行可复现 `_object`；
修复后的实际函数用独占 Node 子进程完成盘点拒绝、盘点超时、关闭拒绝、正常关闭与首次
退出核验失败后重试五条路径，所有 child 均 exit 0，关闭后没有 `process()` 查询。
回执为 `/tmp/codeshell-cloud-chooser-close-{baseline,final}-20261013.json`。
第二次修复另以实际生成模板代码、真实 Node Writable/Readable 和受控 URLLoader 结果
验证九条路径：6346 基线动态查找拒绝、close 后才到拦截错误通过、错误种类不符、收到
响应、仅 close、无结果、拦截计数为 0/2、工厂同步抛错。拒绝路径均不通过，已创建请求
均执行 abort，产品外部/相邻端口请求仍被 wrapper 拒绝；测试将 5 秒 timer 加速到 30ms，
同时核验模板传入的期限仍为 5000ms。回执为
`/tmp/codeshell-cloud-chooser-probe-receipt-20261013.json`。这不是 Chromium/native 成功回执。
真实 Server-only 业务链、生成 Main/worker 的 Node 语法检查及受影响脚本 ESLint/Prettier
均通过；没有重构建产品 dist，没有调用 macOS Keychain。这些结果不能代替新 head 的
Linux 原生 CI 成功回执。

## Linux 原生 gate（CI 待执行）

命令：`xvfb-run -a bun run --cwd packages/desktop test:e2e:cloud-workbench`。
入口先清除继承的 Host/凭据/DBus 环境，再创建私有 SecretService；验证实际 daemon
PID、可执行文件、foreground/control directory 与私有目录后才交给 Electron。
真实 safeStorage 必须报告 `gnome_libsecret`，拒绝 mock-keychain/basic_text。
入口移除 Playwright 追加的 `no-sandbox` 并在 ready 前启用 sandbox，实际 Main 断言
该禁用开关不存在；远端窗口仍须核对其生产隔离属性。
该 gate 仅支持 Linux；不以重试 macOS 系统钥匙串代替当前独立的 Pet 原生验收。

脚本要求完成：

1. 本地 picker 双击去重/取消、原生菜单与 composer 共用选择器。
2. 界面账号登录、实际加密登记、非法 Cloud 地址拒绝、连接/列表/创建/启动。
3. 打开实际管理窗口：精确 project UUID、sandbox/contextIsolation、无 Node/preload、
   HttpOnly/Secure/Strict cookie、Cloud 创建不修改本地项目登记。
4. 停止/确认退出此 Cloud、关闭对应窗口而保留账号、重新连接。
5. 中文/英文 1280/390px 布局、键盘 Tab/Escape 与抽屉焦点恢复；viewport 不算实体手机。
6. 关闭并确认所有已记录的 Electron/worker PID 退出，冷启动同一 HOME，用原生加密
   存储恢复账号和 Cloud 项目；通过实际 preload IPC 执行根账号退出并确认 ACK。

Node 网络只允许实际绑定的 fixture listener；生产 Main 前实拒 Electron native net，
Chromium ready/session hook 在产品窗口前限制请求。唯一允许的产品 child 是精确固定入口的本 Electron stdio worker，
并强制其在 Core 前安装相同 guard。关闭失败、准备失败或退出不明时保留 HOME。
Main 的进程盘点、关闭与已知 PID 退出核验独立执行；盘点失败或超时也仍尝试关闭，
任一步未确认均报失败并保留 HOME。JavaScript guard 是本项测试约束，不声称提供操作系统级隔离。

Linux gate 未出成功回执前，原生 chooser 仍为未完成。最终合入/发版必须核对准确
组合 head 和 CI，不能沿用早期单独候选的绿色状态。

## 开窗后等待关闭 chooser 的诊断

`9d281fbf4144fc5a919425c02ca2e98df680b62f` 的 run `38281749497` 已越过
Chromium 负探针、真实私有 SecretService 登录/加密、连接/创建/启动和新窗口事件，
随后在 `prompt.waitFor({ state: "hidden" })` 30 秒超时。日志为
`/tmp/codeshell-cloud-native-chooser-ci-38281749497.log`。窗口创建早于生产
`loadURL()` 完成，因此该事件不能证明 Main 的 open IPC 已返回成功。

本轮只读沿真实 `onOpened`、Main IPC、managed window、TLS/front/static 路由核对，
尚未发现确定性合同不匹配，也未据此改变产品。测试专用观察器现记录：

- 原固定 open IPC 的开始、等待/成功/拒绝与白名单结果分类；保留真实 handler
  的接收者、返回值和原始 throw，不替代生产操作。
- 最多四个窗口、每个最多十二条导航/加载/关闭事件；URL 仅投影为是否精确 Cloud
  origin、根路径、单一合法 project 参数、是否包含 fragment/user info，错误仅为数值码。
- 原 hidden/heading 断言失败后，最多额外两个 2 秒观察期限打印 chooser alert 分类、
  disabled 按钮数量、窗口状态和 renderer error 数量到 stdout。原 30 秒断言不变；
  不打印错误原文、完整 URL/query、项目/会话身份、token、cookie 或 Account 数据。

Guarded focused shard 为 26/26、142 assertions（观察器返回/throw 保全、凭据与 URL
负例脱敏和有界事件，既有 13 个真实 React 交互场景及导航策略）；三个脚本 Node
语法检查、受影响四文件 ESLint/Prettier 及 diff check 通过。日志为
`/tmp/codeshell-cloud-chooser-open-diagnostics-20261013.log`，SHA-256
`5bd1676ffe2c52693eda29c02fe0107660541919123ea4279aacaff4e46633b8`。
本轮没有启动本机 Electron、Keychain、Core/Main 或构建 dist。
下一准确 head 的 Linux CI 仍需区分 loadURL/IPC 结果与 renderer 关闭回调，不能将这些
纯观察器/React 测试记为原生成功或根因修复。

## 证书指纹绑定修复

组合 `5459addacd3f847117fda8d4e720dbe4649504f2` 的 CI
[38284736457](https://github.com/cjhyy/codeshell/actions/runs/38284736457) 已终态：十一项
成功，Electron chooser 失败。stdout 诊断证实 open IPC 以 `window-load-failed` 拒绝，
Cloud 主 frame `did-fail-load` 数值码为 `-202`，随后窗口关闭；chooser 的错误提示与
保留打开状态符合真实失败结果。此轮不是单纯的 renderer 关闭回调丢失。

旧夹具把 Electron certificate 的 `fingerprint` 字符串按 Node `fingerprint256` 的
十六进制形式比较；Electron 33 的
[converter](https://github.com/electron/electron/blob/v33.4.11/shell/common/gin_converters/net_converter.cc#L87)
使用 `net::HashValue::ToString()`，Chromium 的
[实现](https://chromium.googlesource.com/chromium/src/+/main/net/base/hash_value.cc)
输出 `sha256/` 加 base64，两者不会相等。新 test-only verifier 与先前已通过的真实
managed-window smoke 一致：解析 `certificate.data`，对叶证书重算 SHA-256，只接受
准确 `127.0.0.1` 和本次生成的 Cloud 叶证书。未知/缺失/损坏/其他证书全部返回 `-2`
明确拒绝；不依赖 metadata fingerprint，也不使用关闭 TLS 校验或全域信任开关。
`session-created` 在任何 cookie/导航之前绑定，原 web-contents hook 保留为幂等保障。

Guarded 17/17、71 assertions 覆盖两张实际新生成且同 CN 的不同叶证书、Chromium
格式旧源反例、替换 metadata、错误 hostname、缺失/损坏 data、既有诊断和十三项 React
交互。受影响 ESLint、Prettier、两个脚本语法及 diff check 通过。没有启动本机
Electron/Keychain；完整原生成功仍等待此修复准确新 head 的 Linux CI，所有原 hidden /
heading、冷重启、logout 和进程退出验收保持。
