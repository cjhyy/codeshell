# 第23轮：Relay 重连时凭据与旧连接归属的只读预审

阶段说明：本文为R82收录前的独立只读预审，81项/81文件243测试为当时总数；当前总数以[主报告](README.md)为准。本专项执行和发现增量仍0。

结论：**正式新增0，可信新候选0；Completed；新增实验/测试/模型/CLI/原生进程/网络执行0。** 本轮只读冻结 a66f4ef2 产品源码、现有测试源码及 R01–R81 主报告/流程地图；没有启动服务、导入 Core/Host、运行仓库测试，也没有新增 fixture 或改产品/主报告。正式计数保持81=1P1/52P2/28P3，通用 Bun 81文件243测试/基线不变。

## 选择的窄边界

本轮检查账号型 Device Relay 在“访问凭据临近到期→重连触发 refresh→用户停止连接/退出账号/重新登记→旧异步结果到达”时，新的控制连接、旧数据连接和本机 loopback Host 是否可能使用错误身份或在停止后重新创建。第15轮已静态检查 connector 的一般 timer/generation 清理；本轮补读其**生产账号凭据供应、持久化与撤权接线**，没有把一般重连保护重新算成新发现。

产品入口可达：桌面设置的 `start/stop` 调用 preload 的 `mobileRemote.start/stop`，Main IPC 校验发送者为主窗口/main frame后调用实际 controller；relay 模式实际调用 `createDeviceRelayConnector`，`getCredential` 接实际 `accountDeviceCredential`，`localHost` 接实际 `RemoteHostManager.relayTarget()`。来源：

- [AdvancedSections.tsx:1696](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:1696)、[mobile-remote-api.ts:8](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/mobile-remote-api.ts:8)、[device-relay-ipc.ts:11](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/device-relay-ipc.ts:11)。
- [mobile-remote-controller.ts:209](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:209)、[mobile-remote-controller.ts:275](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:275)。
- 账号登出实际 retireRelay callback 接到同一个 controller，见 [desktop-remote-services.ts:40](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/desktop-remote-services.ts:40)、[cloud-account-manager.ts:330](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/cloud-account-manager.ts:330)。

## 排除的候选与正常保护

| 检查的操作时序 | 源码保护及本轮判断 |
| --- | --- |
| 已提交 refresh 时点击停止，之后旧 refresh 成功 | `stop→invalidate` 先 abort 连接 generation，但不增加 deviceAuthority。已完成轮换允许在同账号/同登记仍有效时保存新 access/refresh token，避免服务端已旋转旧 token 后本机还保留旧值。保存完成后 `signal.throwIfAborted()` 阻止该停止连接取用凭据；connector acquisition 自身也可在 provider 未返回时结束等待。**停止后的凭据落盘是明确恢复设计，不能当作连接复活。** [controller:106](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:106)、[controller:350](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:350)、[controller:404](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:404)、[connector:100](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/connector.ts:100)。 |
| refresh 未返回时退出账号、forget 或重新登记，随后旧 grant 成功 | 这些操作同步增加 deviceAuthority 并清 singleflight 引用；refresh 返回后必须同时匹配 authority、原 registration 对象、signed-in 状态、服务 origin、accountId，且校验 device grant 的 accountId/hostId/audience/到期时间。迟到或存储失败的 grant 会走 best-effort revoke，不会恢复当前 registration。撤销确认仍依赖服务端响应/过期策略；本轮没有将 best-effort 写成远端必然已撤销。 [controller:120](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:120)、[controller:185](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:185)、[controller:315](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:315)、[controller:360](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:360)。 |
| 控制连接断线后凭据轮换，新旧数据流交叉 | 每次 connect 获取凭据，回调要求 running、同 generation、同 control socket及未撤销的 Host；每个控制连接有自己的 lease/owned streams，data stream 使用该控制连接捕获的 credential。旧 control close 关闭自己的 streams；错误 lease 或重复 streamId 终止 control。这里没有发现从可变“最新凭据”给旧 lease 数据连接重新授权的路径。 [connector:149](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/connector.ts:149)、[connector:221](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/connector.ts:221)、[local-stream:88](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/local-stream.ts:88)。 |
| 旧 Host 停止并再次创建本地 listener，旧 welcome/open 晚到 | `relayTarget()` 固定 port 和 Host lifetime，setter同时检查 signal 与 started 对象身份；Host stop 在 await 前 abort lifetime，connector close 在 await 前 fenced generation/abort acquisition/清 reconnect/terminate control/关闭 streams。不能据端口可能被复用就推断旧 relay 可转发给新 Host。 [remote-host-manager:404](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:404)、[remote-host-manager:592](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:592)、[connector:254](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/connector.ts:254)。 |
| 凭据请求或 handshake 失败，担心无限保持 connecting | 生产 credential HTTP transport 有15秒 deadline，controller 首次 ready 等待也有15秒失败反馈；connector setup 10秒、ping20秒/pong60秒、网络失败有界 backoff。401/403明确进入 unauthorized并由 controller 移除本机登记/停止 Host，要求重新登记，不自动无限重试无效身份。没有使用任意自定义 provider 永不 settle 的设想报生产缺陷。 [cloud-account-http:73](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/cloud-account-http.ts:73)、[controller:259](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-controller.ts:259)、[connector:117](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/connector.ts:117)、[connector:179](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/connector.ts:179)、[protocol:9](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/protocol.ts:9)。 |

## 既有正常测试源码与恢复入口

只读到仓库已有两层针对性控制，**本轮未执行，不能作为本轮通过收据或增加既有 suite 数量**：

1. [cloud-account-relay.test.ts:180](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/cloud-account-relay.test.ts:180) 是实际 controller配 Host/store/connector/账号请求替身：停止后提交 rotated token并再次 start不重复 refresh；登出后迟到 token不写回且发出 revoke。断言见同文件283–311。它不证明真实云端轮换原子性或完整 Electron 状态投影。
2. [credential-rotation.mjs:50](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/tests/fixtures/device-relay/credential-rotation.mjs:50) 在已有 native acceptance 中设计 owned TLS relay/loopback控制：同一 control 的 data 使用旧捕获 token，reconnect使用新token；close能结束不响应的 credential acquisition，迟到返回不新建 control。同文件63–112。测试入口为 [relay.native.test.ts:9](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/relay.native.test.ts:9)。这里仅确认测试源码存在与断言意图，未读取或宣称当前运行结果。

用户恢复入口是正式设置 start/stop及登记界面；非ready状态会清 pairing URL并刷新状态，start拒绝会显示错误 toast（[AdvancedSections.tsx:1681](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:1681)、[AdvancedSections.tsx:1704](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:1704)）。明确 unauthorized需要新票据/账号重新登记的 controller消息及 [DeviceRelaySettings.tsx:37](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/DeviceRelaySettings.tsx:37) 为静态恢复接线，本轮未操作实际界面或远端服务。

## 去重和证据范围

- R32是 paired Web secret 持久化失败；本轮是 Desktop relay 的 encrypted device grant轮换，未复述该缺陷。
- R38是 paired Web本地 logout等待 HTTP结束；本轮 controller invalidate先同步fence，不按相同症状另报。
- R67是LAN成功启动缺另一个挂载设置的状态广播；本轮不评估该UI投影。
- R68是配对 Host直播输出的 ws backlog gate缺失；Relay byte-stream写回调分片/backpressure与此独立，见 [byte-stream.ts:22](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/remote-relay/byte-stream.ts:22)。本轮没有用该保护推翻 R68，也不声称实际公网慢读安全。
- R80/R81针对浏览器 grant/parent操作，与relay设备凭据/数据隧道无共同缺陷根因。
- 第7轮 auth正常路径及第15轮 connector一般关闭清理已读；本轮的价值限于补齐账号 refresh与transport cancellation组合的静态反证，没有发现可列入正式报告的新根因。

没有验证真实 Relay cloud对 credential TTL、rotation提交、401/403或旧 lease服务端撤销的行为；没有复跑上述仓库测试、完整App/Main或真实手机。只有冻结 latest源码只读结论，不是两基线动态执行证明。本轮无新可靠候选，不请求扩展实验。
