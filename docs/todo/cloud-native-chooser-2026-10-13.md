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
- 独立审查实际 Bun splitting 产物：静态闭包仅 Node builtins，Core 在 guard 安装后
  动态导入。生成的 Main bootstrap 通过实际 Node 语法检查，生产 Main 动态导入在
  Node、Electron native net、Chromium defaultSession 限制及负探针之后。

## Linux 原生 gate（CI 待执行）

命令：`xvfb-run -a bun run --cwd packages/desktop test:e2e:cloud-workbench`。
入口先清除继承的 Host/凭据/DBus 环境，再创建私有 SecretService；验证实际 daemon
PID、可执行文件、foreground/control directory 与私有目录后才交给 Electron。
真实 safeStorage 必须报告 `gnome_libsecret`，拒绝 mock-keychain/basic_text。
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

Node 网络只允许实际绑定的 fixture listener；生产 Main 前还实拒 Electron native net
及 Chromium 请求。唯一允许的产品 child 是精确固定入口的本 Electron stdio worker，
并强制其在 Core 前安装相同 guard。关闭失败、准备失败或退出不明时保留 HOME。
JavaScript guard 是本项测试约束，不声称提供操作系统级隔离。

Linux gate 未出成功回执前，原生 chooser 仍为未完成。最终合入/发版必须核对准确
组合 head 和 CI，不能沿用早期单独候选的绿色状态。
