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

- Electron 的 `session.defaultSession.fetch` 内部转发到已包装的 `net.fetch`，固定外部
  负探针先被 Main 的 native wrapper 同步拒绝，未到 Chromium webRequest。生成入口
  现在在包装前私有保存原始 native fetch，仅对固定的
  `https://external.invalid/chooser-guard-probe` 使用一次；defaultSession 限制先安装，
  仍要求请求被拒绝且 Chromium 拦截计数精确为 1。产品 `net.request/fetch` 的精确 Cloud
  origin 限制保持不变，没有另开 probe 窗口或扩大请求范围。
- Playwright 在 `app.close()` 后销毁内部对象，再取 `app.process()` 会抛出 `_object`
  错误。两次实际 launch 返回后立即保存真实 ChildProcess 和 PID，关闭及退出核验只用
  已保存句柄；关闭失败后的重试也不再重新查 Playwright 进程。退出未确认仍保留 HOME。

本轮本地验证不启动 Electron：旧基线实际 `closeApp`/退出方法受控执行可复现 `_object`；
修复后的实际函数用独占 Node 子进程完成盘点拒绝、盘点超时、关闭拒绝、正常关闭与首次
退出核验失败后重试五条路径，所有 child 均 exit 0，关闭后没有 `process()` 查询。
回执为 `/tmp/codeshell-cloud-chooser-close-{baseline,final}-20261013.json`。
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
