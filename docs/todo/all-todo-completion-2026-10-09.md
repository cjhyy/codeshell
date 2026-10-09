# 全量 TODO 实施检查点（2026-10-09）

目标：完成当前未完成待办，优先补齐全部三方 Link。根 `TODO.md` 保留未完成条目；
本文件记录工作包、依赖与验收状态，不将设计、fixture、候选构建视为实际发布。

## 当前实施

| 工作包                | 当前状态                                                                                                                                                        | 完成条件                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Link 统一授权前置批次 | PR60/64 已合入 main；系统浏览器 broker、一次性消费、取消／过期与云端交接已验证                                                                                  | 真实 provider 应用与账号另验收；不以 fixture 代替已登录账号                                                                    |
| 全部远程 Link         | Host PR61、services PR18/19、Host PR63 已合并；10 provider 的 26 个原动作及 GitHub 新增 3 动作已实现；PR94／Services PR28 再增显式 Issue 关闭／重开，共 30 动作 | 固定可信 adapter、账号／作用域／资源过滤与续期；九家缺少应用配置和真实账号验证，不能公开为可连接；Issue 增量未纳入 0.9.29      |
| Services 公开包兼容   | PR27 已通过 6 项 CI 并合入 main，源码五个公开 Host 包已升至 0.9.28，SDK override 仍锁为 1.31.0；本地 263 项、6 条依赖链、21 项浏览器及 3 项 CLI 验收通过        | 生产 Link 仍为 ba5363c/0.9.27/schema 3（PR25），Hub 仍为 0.9.23；独立 Hub 候选与旧 Docker 证据不互换，部署及真实业务另验收     |
| Runtime Phase C       | PR62 已通过全部 9 项 CI 并合入 main；真实资源 ownership／关闭路径已验收                                                                                         | host/engine/session/run scope、逆序幂等释放、部分激活回滚、identity disposer、真实关闭路径、两 Engine 隔离及所有 Host 组合验证 |
| 跨 Session 成本       | PR68 账本已合入；PR88 最终 602f538c 通过全部 12 CI 并合为 b6bfe763，受控实际 Electron 两 Session／known+unknown／partial／取消／刷新已验收                      | 真实 provider 账单仍待对照；unknown、估算与自定义 fetch 内部重试限制保留，不代表 macOS OS 钥匙串验收                           |
| Runtime Phase D       | PR73 已合入 main；实际投影、持久请求边界、私有 Host 签名与 Linux 真实 SecretService 验收通过                                                                    | fetch 锚点不证明远端收到／收费；macOS 原生 API/HMAC/冷重启本机验收已通过，不等同于正式发行或独立 OS attestation                |
| Workspace / Link 只读 | PR65 已合入 main；Profile 求交、十家 provider 固定视图及原生 ToolExecutor 链已验证                                                                              | 不扩大已有连接与 grant；跨文件／语义检索及 OCR 另行推进                                                                        |
| 上传解析／索引        | PR70/95 已合入 main；有界 Office/PDF 解析、词法分块、原件重验与逐文件权限通过 12 项 CI；派生索引改为仅内存 32 项/8 MiB，不再写入无读者的磁盘副本                | Core PDF 需 Node 22.13+ 和可选 parser；Desktop 使用已验证 managed Node；不是 OCR 或语义索引                                    |
| Skill 列表预算        | PR72 已合入 main；上下文 1%／最多 2,048 估算 token、排序、按权限搜索与分页通过 12 项 CI                                                                         | 不把估算 token 当作精确 tokenizer 结果                                                                                         |
| 非核心工具渐进发现    | PR81 已合入 main；按步冻结工具集、ToolSearch 选择、撤权重验、真实 MCP 与编译后写操作消费者通过完整组合验收                                                      | 显式 allowlist/Profile 仍按原约束；未声明初始工具集的第三方 preset 保持兼容。该变更已随 0.9.28 发布，不包含于公开 0.9.27       |
| 发布可见性确认        | PR80 已合入 main；发布命令被接受后，统一有界等待公开 registry 精确版本与所请求 tag，35 项回归通过                                                               | 不重复发布、不重写 tag；该变更已随 0.9.28 发布，不包含于公开 0.9.27                                                            |
| Durable 输出恢复      | PR79 最终组合 head cb71fdd3 已通过 12 项 CI、原生包与实际消费者验收并合入 main                                                                                  | 已随 0.9.28 发布；128 MiB journal／16 MiB 单事件有界，任意长度、手机弱网、旧 peer、保留与修复仍未完成                          |
| MCP OAuth 安全        | PR83 已合入 main；Core/Server/Desktop SDK floor 为 ^1.31.0，锁为 1.31.0，Desktop issuer 绑定通过实际 SDK 验收                                                   | Host 新字节已随 0.9.28 发布；旧凭据仅按保存端点续期兼容，不把修复等同于真实账号或新授权验收                                    |
| Profile 切换预览      | PR85 最终 bcae68df 通过全部 12 项 CI，合并为 8da73fe9；两个既有 Desktop 入口共享只读预览与 CAS 确认，已随 0.9.29 发布                                           | 显式 Session 绑定保留，数字人经验提升与 dream 另行推进；静态插件导出见下行                                                     |
| Profile 静态插件导出  | PR89 完成 Core 快照／Main 审阅写入／设置高级入口；原 installer／Skill+Agent loader／spawn namespace 与实际 Electron 审阅已验收，已随 0.9.29 发布                | CodeShell 静态插件，CC 仅目录格式；不保证其他宿主权限等价，不安装或激活                                                        |
| 优化实验室 P1b/P2     | PR67/71 已合入 main；无工具 Agent、指令快照、原生范围化采用与撤销、11 条 signer 清理路径已验证                                                                  | 默认关闭；不覆盖有工具任务或真实收益。临时执行不落盘，授权报告／预算／receipt 持久化                                           |
| 写操作控制            | PR69 已合入 main；持久 operation ledger、单次 claim、GitHub create_issue 独立回读通过实际 SDK/HTTP                                                              | CLI 写入已在 PR77 禁用；早期 fake CLI 证据只证明调用／隔离，不能证明真实 gh 的传输安全                                         |
| GitHub 仓库／Star     | Host PR77 与 services PR21 已合并；单目标 desired state、独立身份／状态回读与 unknown/restart 不重发已验证                                                      | services PR21 已随生产 ba5363c 部署；新动作必须显式授权和单独验收。其他 provider 写语义、批量、人工 reconcile 和保留策略待推进 |
| GitHub Issue 状态     | Host PR94、Services PR28 已合并；固定 repo/issue 身份、单次 PATCH、独立回读及 unknown/restart 不重发通过实际 Node/SDK 验收                                      | 未纳入 0.9.29，未部署生产、未执行真实账号写入；不保证远端 CAS 或 state_reason                                                  |
| Link 目录版本兼容     | Services PR29 已通过 6 项 CI 并合入 main；新 Host 声明编译时 scope，公开目录求交；旧客户端固定基线保留 GitHub 11／全配置共 29 动作                              | 本批次实现与实际四组合验证见[交付边界](link-catalog-compatibility-delivery.md)；目录协商不扩大已有授权，发布／部署仍另验收     |
| 活跃会话关闭          | PR91 已合并并随 0.9.29 发布；真实资源释放与退出路径已验收                                                                                                       | 不把 GUI 验收等同于 macOS 真实 OS 钥匙串验收                                                                                   |

上一批组合按 PR73 → PR71 → PR77 顺序接纳。对应精确 head 为 `f8abbc05`、`adc42100`、
`8817b208`，分别通过全部 12 项必需 CI；PR77 的合并树与当时验收 head 逐字节一致。
Core-engine 1,775／13 skip、Core-rest 2,946、rest 4,421／80 skip、Desktop 4,771／68 skip、
Windows 75 均有完整零失败报告，三个浏览器 driver 独立分片也通过。原生包验收为
9 个 tarball／47 个类型入口／45 个运行入口。SDK、真实 stdio worker、TUI、Star、issue
和 P2 编译后消费者均在 Core 导入前设置私有环境并验证实际子进程回执。

Linux Electron 使用私有 GNOME SecretService、移除 Playwright 的明文／模拟钥匙串开关，
独立核验 5 logical／6 physical 请求与 1 个加密密钥；强制不可用时新增 provider 请求为零。
早期 macOS mock-keychain 结果不计为真实 OS 托管证据。新的受控本机验收已通过真实
SafeStorage、Main 内 wire HMAC 和冷 Electron 重启；保留原失败及私有 HOME 元数据修正，
见[本机钥匙串验收](macos-keychain-acceptance.md)。源码验收不宣称独立 OS attestation
或已发布。历史完整 CI 见
[PR73](https://github.com/cjhyy/codeshell/pull/73)、
[PR71](https://github.com/cjhyy/codeshell/pull/71)及
[PR77](https://github.com/cjhyy/codeshell/pull/77)。

Host [v0.9.27](https://github.com/cjhyy/codeshell/releases/tag/v0.9.27) 已正式发布，
源码为 `79e6e95f5bb4899b2632bc25c7dd5c5d18448fd4`。发布流水线七项成功，14 份
Release 资产的版本和引用已核对；九个公开 npm 包的精确版本及 latest 均在
2026-10-08 21:45:06 UTC 确认为 0.9.27。后续 PR80/81 分别在精确 head `34d8bb10`、
`3a6cf433` 通过全部 12 项 CI 并合并；PR83 的 SDK 1.31 与 Desktop issuer 修复也已合入 main。
PR79 最终组合 head `cb71fdd3963930c42c20ac35c6a0f6bcde0647c6` 在
[Actions 37855241831](https://github.com/cjhyy/codeshell/actions/runs/37855241831) 通过全部
12 项 CI，并完成 fresh 9 tarball／47 类型入口／45 运行入口与实际原生消费者验收。
合并结果 `49fded8ad1f0f198973226b08422a87924ad5d6e` 与该验收 head 逐字节一致。
上述 PR79/80/81/83 的新增字节已随
[Host v0.9.28](https://github.com/cjhyy/codeshell/releases/tag/v0.9.28) 正式发布，tag 指向
`06aa2c56420d783625c749dac6ea86bb85964a54`。
[发行流水线 37857705007](https://github.com/cjhyy/codeshell/actions/runs/37857705007) 七项均成功；
2026-10-08 23:24:54 UTC 独立公开读回确认九包 exact/latest 均为 0.9.28，14 份资产包括
6 个安装包、5 个 blockmap 和 3 份版本及资产引用正确的更新清单。该读回核验公开元数据、
资产存在与大小，没有再次下载全部安装包字节。原有 0.9.27 tag、发布资产和验收记录不改写。
Profile 切换预览为独立后续，不纳入该 tag。其
[PR85](https://github.com/cjhyy/codeshell/pull/85) 最终 head
`bcae68df267973ff0bc569c95719711d3a3c2bd7` 在
[Actions 37858908356](https://github.com/cjhyy/codeshell/actions/runs/37858908356) 通过全部
12 项 CI，合并为 `8da73fe921b8fb2a66aca76157cb343de5002dfe`，两树完全一致。
本地完整 guarded 四分片及真实隔离 Electron 双入口／缺失旧定义恢复验收通过；最后迁移
兼容修正另通过 100 项 settings/Main 回归，最终 Desktop 完整分片 4,803 项／68 skip／零失败。
该功能复用现有设置和数字人页，不新增导航；详细边界见
[切换预览交付](workspace-profile-switch-preview.md)。

跨 Session 成本的受控实际 Electron 验收随后在
[PR88](https://github.com/cjhyy/codeshell/pull/88) 完成：最终 head
`602f538c6b7864d13fbebc84840a2fccfe0fb359` 在
[Actions 37861580874](https://github.com/cjhyy/codeshell/actions/runs/37861580874) 通过全部
12 项 CI，正常合并为 `b6bfe7637a069507d9698822d9af886563c87acf`，合并树与验收 head 一致。
使用公开 Core writer 的合成两 Session 请求证据，验收 known/unknown、partial、取消、
刷新和生产 Main IPC 冷读；没有真实模型或 provider 账单对照，也不补足 macOS 真实
OS 钥匙串验收。细节见[成本交付](runtime-cross-session-cost-ledger-delivery.md)。

[PR89](https://github.com/cjhyy/codeshell/pull/89) 完成 Profile 静态插件导出的源码与本地组合验收：
仅在 Settings → 数字人 → 高级导出选择、完整审阅并接受损失，再写入新目录；原 JSON 导出保留。
真实原 installer／Skill+Agent loader／spawn namespace 与 Electron 的全文、损失、接受门槛
及取消路径已验收；OS picker 仅 stub 取消结果，不代表物理 sheet 点击。只验 CodeShell
静态插件，CC 为目录布局，不保证 CC 执行／Codex 兼容／其他宿主权限等价。该变更未纳入
v0.9.28；最终组合 CI 与合并记录以 PR89 为准，详细边界见[静态插件交付](workspace-profile-static-plugin-export.md)。

Services [PR23](https://github.com/cjhyy/codeshell-services/pull/23) 记录了公开 0.9.27
原锁的真实 Linux 双镜像构建、五包能力检查、禁网 CLI 启动与容器内健康检查。
同一构建发现 SDK 1.30.0 的
[GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)。
该历史候选保留一个 high，不作为依赖安全验收通过。
Services [PR24](https://github.com/cjhyy/codeshell-services/pull/24) 已合并为
`ba5363c929042a21600d76cb89b9a70eddb076fa`：保持五个公开 Host 包为 0.9.27，
以 override 将 SDK 精确锁为 1.31.0，其他第三方 resolution 不变；修复源码、新双 Docker
候选与 staging 已通过验收。Host PR83 的 SDK 与 Desktop issuer 修复已随 0.9.28 发行。
生产 Link 随后完成单独维护，见下一段。Services 源码现由
[PR27](https://github.com/cjhyy/codeshell-services/pull/27) 升级五个公开 Host 包至 0.9.28，
SDK override 保持 1.31.0；本地 263 项、6 条依赖链、21 项浏览器及 3 项 CLI 验收与全部
6 项 CI 通过，合并为 `d67e62c42ccbf7cf598f067df77cb44595f64f85`，与验收 head
`09f4c200e915d5838ac1e662ece27dc68e55c36c` 树一致。生产 Link 仍为下述 ba5363c/0.9.27，
Hub 仍为 0.9.23；独立 Hub 候选不沿用旧 Docker 身份，不把源码合并当成部署。

此前服务器 Link 在 services `82d0e4d` 上完成的验收保留为历史证据：健康检查返回
schema 3，HTTPS 证书验证通过。
原有 GitHub 连接在停机维护中完成一次自动续期、原账号校验、资源发现和现有 grant 下的
只读调用；既有账号绑定、客户端和授权关系保持不变。在线／停机／升级后备份及新旧工具
离线恢复通过，密钥另存 root 私有备份；不把离线恢复当成实际线上降级。完整证据见
[目标 Link 验收](https://github.com/cjhyy/codeshell-services/blob/0469c4b87e14b4816c304bfbec4d314fd5c46781/docs/link-target-acceptance-2026-10-09.md)。VPN 路径问题通过
单连接绑定物理网卡解决，不修改系统路由或关闭证书验证。生产私密配置只确认已配置
GitHub OAuth；其余 provider 应用配置和真实账号验收仍待提供，不能以受控上游替代。
随后生产 Link 已由 `82d0e4d` 升级为 services
`ba5363c929042a21600d76cb89b9a70eddb076fa`，完整记录见
[Services PR25](https://github.com/cjhyy/codeshell-services/pull/25) 与
[维护回执](https://github.com/cjhyy/codeshell-services/blob/b6333533af08b1ed87f203d7d2dc935c6dd9c74a/docs/link-production-sdk-upgrade-2026-10-09.md)。
源码与进程路径、五个公开包 0.9.27、Core/Server SDK 1.31.0、schema 3、只读完整性、
服务和文件权限、TLS 健康与 catalog 已核对；GitHub catalog 从 8 增为 11 个动作，
其余九家继续隐藏。保留原 unit、Node 22.22.1、配置和生产数据库，本次维护未新增授权。
本次维护没有实际 provider／账号调用，也没有逐行比较 grant；此前的真实账号验收
不能冒充新版本验收。stop→start 为 17 秒，不等同于端到端停机实测。

在线及停机 SQLite 备份、独立密钥备份继续由服务器 root 私有保管。实际回滚未执行；
代码回滚先保留最新数据库、WAL 和已轮换令牌，再停止新进程、切换代码、启动旧版。
不得恢复已经消费旧 refresh token 的快照；旧代码会重新引入 SDK 1.30.0 的已知问题，
不称为安全修复通过。当前生产 Hub 仍运行公开 0.9.23，候选准备与上线另记。

## 后续工作包

截至本检查点，Host [v0.9.29](https://github.com/cjhyy/codeshell/releases/tag/v0.9.29)
已发布，冻结源码为 `0339e8bc7c789fbb9256f8a0e761d3c995db5709`，
[发行流水线 37867978298](https://github.com/cjhyy/codeshell/actions/runs/37867978298)
七项成功。九个 npm 包 exact/latest 均已确认 0.9.29，并独立核验九包 SRI 与 archive
结构；14 份公开资产元数据已核对，其中三份更新清单实际下载并校验 SHA256。
本次公开读回未执行安装器，也未独立下载全部安装器／blockmap 字节。
0.9.27/0.9.28 的 tag、Release 正文和资产身份保持不变。PR93 的 CI fixture 修正与
PR94 的 Issue 状态增量在冻结源码之后，不移动已有 tag，也不把当前 main 等同于 0.9.29。
Services PR28 已合入 `4bec9daa`，五个公开 Host 包仍为 0.9.28、SDK override 1.31.0；
源码交付不等同于生产升级。公开 Link 只读核对仍仅展示 GitHub 11 动作，其他九家未配置。

1. 跨 Session 成本的真实 provider 账单对照；macOS 本机原生钥匙串/HMAC/冷重启验收已完成，独立 OS attestation 不在本批承诺。
   受控 Electron GUI 两 Session／known+unknown／partial／取消／刷新已由 PR88 完成，不能代替真实账单。
   Runtime MCP pool 已有实现，补核多 Session/项目隔离、释放和汇总展示，避免重复重建。
2. Workspace 跨文件／语义查询及 OCR；上传解析／索引、Profile 求交与现有 Link 只读视图已实现。
   写操作的其他 provider 语义、批量 slots、人工 reconcile 与账本保留策略仍待逐项接入。
3. 更多真实工具的后置验证和错误预算适配，以及真实长程与按模型配对评测、通用评测
   adapter。Skill 预算已发布；非核心工具渐进发现已合入 main，已随 0.9.28 正式发行。
4. 优化实验室真实模型实验、报告价值评价和有工具的任务试验，须按原授权要求完成。
5. 数字人经验提升流程；切换影响预览和 PR89 静态插件导出已随 v0.9.29 发布。
   受约束 dream 先确定 ownership/审批，不自动写 portable profile memory。
6. Durable 流式 journal、共同游标、分页恢复和重启代次映射已在
   [PR79](https://github.com/cjhyy/codeshell/pull/79) 最终组合验收后合入 main，并随 0.9.28
   发行。真实 SDK、Main/Hub/stdio、缓存身份配对与排队输入身份已有最终 head 证据；
   128 MiB journal、16 MiB 单事件及有界旧 transcript 恢复限制继续保留。
   任意长度日志、实体手机弱网／后台恢复、旧 peer、修复和保留策略仍未完成。
7. Cloud/Link/设备中继的兼容公开包与镜像、目标服务器部署、真实业务、恢复与升级回滚。
   六 Panel 四组合、真实第三方账号、实体手机弱网/后台恢复/通知和 Pet 实际加载验收
   分别记录；未执行的项目继续留在 TODO。

## 保留既有产品边界

Panel 内部业务和手机界面按 2026-09-27 决定暂缓；不可信 Runner、多租户/SSO、
Memory P2、quick-chat 树状 Session、IM 编排大脑、同 Workspace 多 active Profile、
Mimi TodoWrite 聚合及向量记忆不因“全部 TODO”自动翻案。跨仓职责仍以各仓库说明为准。
侧边栏精简已合入 main；任务中心和其他低频功能继续从设置访问，不因新接入增添入口。
