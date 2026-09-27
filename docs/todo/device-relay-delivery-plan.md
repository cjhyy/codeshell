# 稳定电脑入口与设备中继：首个交付范围

2026-09-27 公共连接器、Services 目录/中继及桌面设置入口已实现并合入。独立
Node22.16 真实 TLS/WSS、实际 Electron/OS 密钥环和完整 Linux 候选 36301566352
均通过；含实际双项目/中继、备份恢复、镜像重新加载与归档。Host #43 正常合入
`220a3799`，#41/#42/#44/#45 随之实际标记 MERGED；Services #14 合入 `809dd334`。
候选仍固定 Host7a21/Servicesec7/Panel577 原始来源，不能改标为合并提交。
Services 后续纯文档 #15 合入 `a87cfe0c`，补配置加载与独立验收 artifact 位置，
不改变候选源码/包。公网部署、真实 provider 与物理手机未验收，Panel 内容冻结。

## 设备目录恢复候选（检查点119）

原候选通过网络/撤销/重启，不包含设备目录快照恢复。真实旧版本探针确认直接复制
旧快照会恢复曾撤销的session/credential/ticket；本轮已补受控停机备份与新目录恢复。
完整Linux候选36306016201（准确Host8314/Servicesbab72/Panel577）通过第十五stage、
九项恢复、Cloud恢复、真实语音、镜像校验及归档，原始ZIP已保全。Host #46已合入
99940e7f；Services #16代码bab72及纯文档774a1c7已合入49bcc157，最终六项CI全通过。
Node22.16完整166项、独立恢复70项、初始化故障10项及有限同schema升级回退均通过。
只有命令成功后才配置恢复目标；失败或中断目标不得上线，初次mkdir到首文件之间的
强制kill不宣称零窗口原子保证。公网/provider/目标机器及实体手机仍待，Panel冻结。
before、故障和版本切换证据在`project-cloud-panels/artifacts/device-relay-recovery/`；
新候选证据在`project-cloud-panels/artifacts/cloud-candidate-36306016201-evidence/`。

## 产品边界

services 提供设备目录和受信中继；桌面主动建立出站连接；手机访问电脑的稳定地址，
继续经过现有访问口令、配对和 Host 权限检查。本地项目始终在电脑上执行，离线不
切换到云端。Cloud、Link、设备中继可以同机部署，设备中继继续放在 services 仓库，
不需要第四个仓库。

若中继终止手机 TLS 并经出站隧道转发，它能够看到请求和凭据。首版明确它是单 owner
自管的受信组件，不声称端到端加密或零知晓。禁止记录 Cookie、Authorization、配对
票据、手机 secret、请求正文及敏感查询字符串。

## 复用现有接入口

- Desktop `startMobileRemote()` 先启动本机 `RemoteHostManager`，再启动新出站
  连接器。新增生命周期独立成模块，不继续扩大主进程入口。
- `RemoteHostManager.start()`、`setPublicBaseUrl()`、`createPairingUrl()` 增加
  明确 relay 模式，强制回环监听、禁止开发代理，保留 `AccessPasscode`。不能冒充
  没有公网门禁的 LAN 模式。
- `desktop-web/http-api.ts` 的 `sameOrigin()`、`authorized()`、`revokeDevice()`
  及 `RemoteHostManager` 的 WS 鉴权、撤销、viewer 释放继续作为最终权限边界。
  稳定外部 Host/Origin 必须完整保留，不能改写成本机地址来绕过同源检查。
- `MobileRemoteOrchestrator` 继续解析工作区及会话、进入 Worker／审批路径。
  中继不能直接调用 Worker，每条手机 WS 对应独立的本地 WS。
- `environmentIdentity()` 已提供桌面环境 UUID。上报 `environmentId`，服务端另
  签发 `hostId`，两者都不能与手机 `TrustedDeviceStore.deviceId` 混用。
- `project-runtime/proxy.ts` 可参考背压与代次检查，但不能直接用来转发电脑：它
  通过云端私有密码取得内层管理员 Cookie；电脑必须保留手机自身的配对授权。

## 稳定地址与身份

每台电脑使用独立 origin，例如 `https://<hostId>.devices.example.com/mobile`。
现有手机代码使用当前 origin 的 `/ws`、根路径 `/api/v1/`、`Path=/` Cookie 及
origin 内配对存储。仅加 `/devices/:id` 路径前缀会破坏路由与凭据隔离。
目录使用另一 origin；Cookie 保持 host-only，不设置共享父域 `Domain=`。

首版单进程、单 owner。owner 登录后签发短时单次登记票据；电脑登记获得稳定地址
及仅用于本电脑出站连接的凭据。目录登录不授予电脑操作权限，手机仍完成原配对。
ownerId 由已认证会话和本次安装确定，不接受客户端指定。

拟新增接口：登记票据、登记兑换、设备列表、撤销设备以及出站 WS connect。
列表仅返回名称、hostId、environmentId、在线状态、最后在线时间、固定地址和协议
版本，不返回连接凭据。目录登录、电脑出站、手机配对、Link 第三方授权相互分离。

Host #40 已将 `createHubAuth()` 和必要 cookie 常量／类型从版本化 `/auth`
公开导出；services 不读取包内私有路径或复制登录实现，内部 store 不额外导出。首版
可以明确目录单独登录，不宣称 Cloud、Link 与目录已统一账户体系。

## 传输与撤销

连接器放在 Host 的纯 Node remote-relay 模块，只连接本次启动返回的固定回环端口，
不接受任意目标 URL／端口。HTTP 支持上传、下载、Range、流式响应、取消和背压；
WS 保留顺序、消息类型与连接隔离。限制头大小、并发流、单流及总缓冲，拒绝 CONNECT、
绝对 URL 请求和未批准的升级路径。

连接执行权由服务端签发的 `hostId + credentialEpoch + connectionGeneration +
serverBootId` 共同确定。新有效连接原子替换旧连接并关闭旧流；旧 close、心跳、
就绪回调及迟到响应必须核对当前连接，不能把新连接标离线或完成新请求。
服务重启后所有电脑先离线，只有重新认证且本地 Host 就绪后才上线。

Host 自身也保留启动代次，避免停止后迟到回调重新设置公网地址。撤销电脑关闭其
全部转发并拒绝旧凭据重连；撤销手机沿用 Host 原有设备撤销。断线重建传输并读状态，
不重放结果不明的 POST、聊天发送或审批决定。

实现约束补充：连接器不得仅接收裸端口及依赖调用方记得先关闭。relay 模式 Host
签发本次启动的目标能力（固定回环端口、AbortSignal、绑定代次的公网地址 setter）；
Host 停止时先同步撤销能力并销毁旧传输。旧目标不可重新启动，迟到 welcome 不可
改新 Host 的地址；必须用实际停止并复用同端口的负例验证，不能转发到替代进程。

## 两仓首个配套 PR

Host：最小公开 auth 接口、纯 Node 连接器及协议校验、RemoteHostManager relay
模式和真实本地 Host 权限验证。services：单 owner 登记存储、目录、凭据摘要、
连接代次、HTTP/WS 中继、启动配置及最小目录入口。在线状态只来自当前活连接。

首个闭环不包含项目聚合、迁移、通知、多实例或手机 Panel 界面。桌面设置入口已在
配套 #45 实现，并通过实际 Electron/OS 密钥环/受控 TLS 验收；此结果与实际 Services
跨仓网络验收分别记录，均不冒充公网或物理手机交付。

## 真实网络验收

使用真实 Node、WSS/TLS 测试证书、RemoteHostManager 和隔离目录验证：

- 单次登记、未登记拒绝、电脑凭据不能管理目录；未配对手机不能操作 Host。
- 两电脑、两手机、多 tab 的 Cookie、消息和资源释放隔离；伪造工作区拒绝。
- 上传／Range 下载字节一致，慢接收背压、超限和取消不影响并行请求。
- 注入旧连接心跳、close、响应；新连接的状态与结果不受影响。
- 操作已执行但响应丢失后重连，写入不重复。
- 运行中撤销手机／电脑立即失效；重启目录先离线，认证就绪后恢复。
- 后续实际 Electron→中继→浏览器验收审批与结果；物理手机弱网、后台恢复另验。
