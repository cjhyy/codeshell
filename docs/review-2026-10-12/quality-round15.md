# 第十五轮整合最终只读语义核验

Completed。本轮新增执行 **0 测试 / 0 模型 / 0 服务或原生实验**。只读取报告、源码/fixture片段、已有日志与JSON；用只读文本解析校验统计。唯一写入是本文 `/tmp/codeshell-review-20261012-quality-round15.md`，未改产品、主报告、goal或构建。

核验主目录：`/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/`。已读 README、flow-coverage、latest-baseline、reproductions/README，CLI/remote-settings/connection-recovery 三份 round15 专项与三份 quality，初始及 latest 两份 reproduction-results JSON、latest summary，以及对应既有完成日志和两基线 native observation JSON。

## 结论

**保留 R66/C15-1/P2、R67/MR1/P3、R68/W26/P2；未发现需要撤回、合并、改级或修改统计的实质语义冲突。** 原始代理单基线运行、只读复核者新增执行0与主审随后双基线便携复跑分别注明；不把“源码无diff”当作旧基线执行证据。此前连接标题中的 indefinitely 已改为应用缺少backlog bound，符合独立复核要求。

## 数量及日志一致性

只读解析当前 README 编号表得：68行且68个唯一编号，**P1=1、P2=46、P3=21**。

| 元数据 | 唯一文件 | 测试 | 跳过 | 日志核对 |
| --- | ---: | ---: | ---: | --- |
| `validation/reproduction-results.json` | 68 | 211 | 0 | 全68条code0/signal null，实际日志Completed数量与metadata相同，0fail |
| `validation/latest-a66f4ef2/reproduction-results.json` | 68 | 211 | 0 | 同上；使用各条archiveLog读取latest独立日志 |

本轮6文件在**每一份基线集合**均为：

| 文件 | Tests | Bun expect |
| --- | ---: | ---: |
| CLI room-recovery-controls | 3 | 40 |
| CLI takeover-mode | 2 | 53 |
| CLI web-room-recovery | 2 | 15 |
| Remote settings | 3 | 23 |
| Connection hub-outbound-control | 1 | 9 |
| Connection native-outbound wrapper | 1 | 2 |
| 合计 | **12** | **142** |

均有 `Completed Bun shard`，0 fail/skip。CLI 7/108 + UI 3/23 + connection 2/11正确。68/211是截至本轮通用累计，新增6/12未重复加原始开发日志，未混入latest-only3文件8测试，native单次实验证据及原有其他测试也未再加。

latest `summary.json` 的68/211、nativeOutboundAssertions=33与说明相符。原生mjs属于一个Bun wrapper test内部执行，**每基线33个Node断言另列，不额外加Bun文件、测试或expect数**。既有metadata总数未把两基线相加。

## R66 — 模式授权与恢复边界正确

生产场景是A保留已合法打开的旧observe-only linked view；B对同一room先合法接管、再明确选择bypass普通重开；A随后点实际接管。RoomManager先将metadata改default，再由open复用当前bypass实例，A的default标题/composer及下一稿路由与实际实例配置不一致。冷接管/default幂等有对照。

- 已注明B的bypass本来是显式选择，fixture cwd同时已注册且trusted；Desktop普通Main openSession只核对注册路径/磁盘身份，不声称它调用了paired trust resolver。配对端另有resolver，非trusted请求降default。没有扩大成任意cwd绕过、A新启动未经批准的bypass或真实CLI已免审批执行工具。
- A的实际组件、按钮/标题/输入动态执行；B与恢复是实际Main callback/service调用，参数接线静态核对。agent factory是记录spawn-time配置的内存替身；没有真实Electron双窗、真实CLI/DriveAgent、完整preload transport或真实工具动作。
- 重要恢复限制保留：同值default重开不能修复，因为metadata已先变default；实际Main acceptEdits→default两次模式变更可替换实例。返回/关闭tab/leave只退订或清视图，不能当作kill服务恢复。closeSession仅服务/IPC能力无当前UI调用入口；应用重启未作为本轮完整native实测。
- 与R02独立：R02是Web select向native协议发错路由；R66是正确room takeover backend写metadata后复用错误配置实例。两处修复不能相互替代。与R18 failed-spawn、R62残留审批亦不同。

README、专项、quality和flow的简写与上述限定一致；P2未泛化为P1或未授权安全利用。

## R67 — 两实例替身、启动前提与恢复边界正确

前提保留为已有两份已挂载设置、最初LAN关闭且未登记relay。成功LAN start仅发起方refresh；另一份没有post-start事件，显示closed/start可用/stop禁用。未扩大到所有模式/所有start失败，也不将online-device集合误当Host running更新。

- 实测为完整实际MobileRemoteSection+实际preload API/IPC controller/真实owned loopback Host，**同一MiniDOM和同一个注册sender内两组件根**；真实两个Electron窗口及多个WebContents合法门禁关系仅生产接线核对。bind仅替换到127.0.0.1，QR/选择器、IPC传输/safeStorage等替身已列，未声称LAN手机端到端、真实账户/WS配对实测。
- 最终第二控制先令observer显示running，再stop并观察两份closed/广播，是真实状态转换，非原本一直closed的弱控制。第三控制再次start复用同一个端口，并保持owner/frame拒绝，不能推论第二监听器泄漏或越权。
- 重挂设置或observer幂等start恢复；刷新QR仅有pairingUrl时可用，不被误写成初始stale observer始终可用的status refresh。P3符合可恢复的状态/控制入口影响，未声称整个服务无法关闭。
- 与R47自动化详情订阅和R61共享会话选择广播根因独立。

## R68 — 原生、模式范围及恢复边界正确

原生实验确为Node v25.8.1/darwin、合法auth.device、owned TrustedDeviceStore与loopback WS，实际暂停一个reader，server send/bufferedAmount/write未替换。Main普通native worker mirror→Host入口仅源码，fixture直接调用真实Host方法；没有真实Main worker或模型。

两份归档JSON与专项最终双基线表格完全相同：

| 基线 | broadcast后 | device raw后 | 普通回复后 |
| --- | ---: | ---: | ---: |
| 84740 | 15,304,063 | 23,711,487 | 23,711,529 |
| a66f | 14,647,243 | 23,054,667 | 23,054,709 |

两者均33个native断言、24MiB text payload上限、384帧、健康peer收齐且backlog0、慢peer仍OPEN。前文13,859,059/22,266,483/22,266,525是代理**原始a66f运行**，并明确与主审便携两次区分，不是矛盾，也没有将TCP缓冲差异当基线产品差异。

- 该上限是测试text payload量，未当作总网络字节、RSS或产品队列上限；OOM、全局故障、无限时间保持OPEN及自然网络速率均未实测/未断言。P2依据应用缺少bound与实际写队列增长；长期资源耗尽是风险推论。
- 同一慢peer随后通过已有sendToViewer的4MiB cap被退役，健康peer保留；重新认证/选定回复与remove→revoke、旧凭据拒绝实际通过。恢复读取理论可drain，但脚本resume在terminate之后，不声称测过自然catchup时间。
- owned-external selected stream走reply→sendToViewer已有cap，未说它也失效。Hub使用另一套有界transport，Hub正常控制明确mock backlog，不能算第二个native测量。raw-device用session.stream仅验证公开传输行为，不把它称真实审批重放。
- HTTP/fetch exact-origin守卫在Host/Core前安装，fixture ws bootstrap仅允许owned端点的标准HTTP connector；不是OS或通用net/tls confinement。Bun早期诊断被排除，不以Bun amount0反证Node。成功exit0/Completed在finally后支持此次清理；timer没有被描述成所有异常/后代进程强杀均验证。
- 与R10/R17/R31/R34/R38/R41等旧根因独立，broadcast/device漏gate合并为单一R68合理。

## 表述及便携性收尾

三个专项保留代理原始审查阶段的“只运行latest/主审可另跑”句子，但后续都有明确主审双基线复核章节，README与latest-baseline将其作为独立后续验证，不构成实质冲突。若将来重写为面向最终读者的报告，可把这些原始阶段句子统一标注“代理初审时”，属可读性润色，不影响本轮结论。

已读取的round15运行命令使用 `docs/review-2026-10-12/reproductions/...` 完整仓库根路径，未发现此前round14那种缺前缀命令问题。诊断文件非活动test并存于validation/original-*；未进入收集元数据。

Completed：最终建议保留全部三项与68/211、1/46/21统计；本审计新增执行仍为0，无需因此增加任何测试或发现编号。
