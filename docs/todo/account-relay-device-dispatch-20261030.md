# 登录即设备协作：最小端到端交付

目标：Desktop 密码/GitHub 登录或显式恢复会话后自动登记并保持出站 Relay；主流程选择真实电脑/项目派发，复用既有 Host/Mobile worker 通道。

## 协议与边界

- Account authority 是唯一账号/会话所有者；组合服务注入同一 store，沿用原 ACCOUNT_DATA_DIR，Relay 数据目录独立。
- 从已登录的 exact origin 获取可信 relay capability；目前仅支持同源目录。缺少能力只影响协作，不影响账号和本地工作。
- main 保存稳定 environmentId 与 OS 加密 device grant。首次 ensure 可登记，已有有效 grant ensure/reconnect/refresh 不旋转；显式 enroll 保留旋转语义。构造和只读 status 不联网。
- 密码/GitHub 成功或显式 resume 才启动协作。账号和 refresh 凭据只在 main/OS store；网页账号登录不登记电脑。
- 选目标需 Account 签发 30 秒单次精确 host/environment/连接代次交接，目标 Host 用自身 device grant 在目录消费后建立有界 Host 会话。账号 bearer 不发给电脑。Relay 对发起会话/目标持续校验，退出/撤销断流。原 LAN/passcode 与工具/OS 审批保留。
- main remote adapter 连接既有 /ws Mobile 协议；真实项目来自 Host 项目权威。每目标/项目/session 独立草稿、附件、输出、取消；切换不重定向在途动作；离线拒发；不自动重发未知结果动作。

## 验证与交付

使用隔离 HOME、准确 origin guard、受控 stdio producer，不使用真实账号/密钥/付费模型。覆盖两账号多电脑、重启/刷新复用、单次交接、任务输出/审批/取消、离线与撤销、切换归属及 renderer UI。两仓分别提交；公开依赖与候选 tarball 测试分离。实际公网部署另列前置条件。

### 组合检查

- Services 配套候选为 `cef3776df52ae85c3e5edd7a7b1b5accba59d1bf`：全套 740 项，739 通过、0 失败、1 个既有平台跳过；真实网络目标 21/21，memory adapter 24/24。
- Host Server 原生及相关 guarded shard：96 通过、0 失败、0 跳过。包含实际 HTTP/WS、既有 Relay TLS、普通配对与账号授权隔离、撤销和到期断流。
- 组合 fixture 运行实际 Account、Relay、Host HTTP/WS 解析器与受控 stdio 进程；字节传输为隔离 memory adapter，不能当作真实 TCP/TLS 或公网验收。调用：`SERVICES_CHECKOUT_PATH=/absolute/path/to/reviewed/services bun run test:account-relay-device-dispatch`。
- 浏览器 fixture 直接构建生产组件，覆盖电脑/项目选择、输出、草稿/附件隔离、原电脑 Stop、审批代次、快速完成先于 IPC 回复、迟到目录、超大帧预检、恢复原会话、退出和 390px 布局：`node packages/desktop/src/renderer/runtime/AccountDeviceWorkspace.browser.fixture.mjs`。
- 真实隔离 Electron `contextBridge` 验收：`bun run test:account-device-bridge`，当前 4 种投递结果均通过。跨桥使用可序列化 DTO；Electron 会丢失自定义 Error 字段，不能靠 `Error.delivery` 跨桥保留投递确定性。receipt 默认保存在 `.code-shell/artifacts/account-relay/account-device-bridge.json`。
- 原后台运行的长时间测试停滞未能复现；原生 fixture 的编译及执行现在均有独立硬截止，后续 shard 另以外部进程组总期限验证。

### 交互与授权边界

- 超出最终 1 MiB WS 帧限额的任务/图片在发送前拒绝；已知未发送与发送结果未知分别回传，未知输入不重发。
- 授权到期/断线后可显式“恢复原会话”，保留 Host、项目、Session、草稿与输出，恢复 Stop 和审批；不会创建替代任务或重放输入。断线期间完整历史尚未自动补齐，界面明确要求核对，不将重新订阅宣称为完整恢复。
- Services 复用现有 Account 监听器、数据根和账号身份；部署需开启 `ACCOUNT_DEVICE_RELAY_ENABLED=1` 并提供独立设备 wildcard DNS/TLS。当前真实设备域名尚待提供。
- 分离的 Account/Relay 两目录需做一致离线备份与恢复演练；旧 `ACCOUNT_RECOVERY_MODE=relay` 嵌套布局工具不能直接用于新布局。生产数据、正在运行的 Desktop 和服务均未修改。

## 工作路径

指定外部任务 worktree 因沙箱只读而无法写入；从相同任务分支干净 clone 到本 repo .worktrees/account-relay-device-dispatch-20261030-{host,services}，不修改主目录预存文件。
