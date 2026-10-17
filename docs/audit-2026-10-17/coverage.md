# 覆盖范围与未完成项

冻结源码 `ab8b03f86ad38835939d4125b56bf4513cae7f15`。本轮重新查看当前实现，以自有数据验证；先前报告只用于查重。文件清单、哈希、通过测试数都不等于全仓覆盖。

| 范围 | 实际做过的审阅/验证 | 本轮缺口 |
| --- | --- | --- |
| Core sources/documents | Office XML/ZIP parser、index/search/chunk/cache/adapters、collection refresh；纯 parser 与真实本地 handler/worker | 完整 Office schema/真实 Office 软件、PDF、远程数据、所有竞态/异常 |
| Core operations/memory | ledger/archive/controller/recovery、summary、自动提取/合并/提升、项目根存储；实际本地 manager、fake LLM、独立基线 | 真实模型、账户、进程 crash、多进程压力、失败同名支架未重跑 |
| Core run/progress/automation | run 恢复/队列/进度、cron field/日历/时区/one-shot、Sleep acknowledgement；纯函数、fake timer、内存 scheduler | 真实等待/执行器、suspend/wake、完整任务生命周期与 UI |
| Coding | Claude/Codex discovery/history、changed-files、DriveAgent 接线、apply_patch 语法 | 外部真实 CLI、takeover、实际 patch 执行、其他 Git/LSP/worktree 能力全量 |
| TUI | Markdown export、Markdown hybrid/table、选择性 Unicode/render helpers；真实离屏 renderer | 真实终端交互/PTY、完整 REPL；误写的既有 MessageContent suite 未运行 |
| Desktop | 评论编解码、普通草稿/附件/设置/预览状态选择性阅读、legacy tail 上下文选择、Review parser | 实际 Electron 点击/剪贴板/fork/评论发送；原生/浏览器/Panel 等未新增验证 |
| Web | cwd 项目归属/分组、DesktopApp target 接线、消息/草稿与 Hub 页面选择性阅读 | Linux 真实 Host 注册/UI、新会话实际创建、网络/移动设备 |
| Pet | disclosure 搜索/reader、segment/终态隔离/session list/ordinal/receipt、投影关键段 | 真实 Pet/Desktop/IM、协议传输、模型和发送 |
| Chat | 适配器普通消息文本/附件/命令/thread 投影、gateway/bound-session 接线；真实本地 Adapter/Gateway + fake SDK | 真实连接/平台发送、Discord 依赖失败方向、完整第三方 SDK 验收 |
| Browser-devtools | 本轮只读 inspector.ts 的普通 DOM/performance/record 数据流程 | 未动态验证，无新增确认项；不把读过一个文件当完整包审阅 |
| Server、Host、Link、CDP | 本轮未作新的完整模块审阅；旧 10-16 报告保持冻结 | 需未来独立验证，不能从旧报告推断当前无缺陷 |
| Arena、optimization-lab | 本轮未覆盖私有/实验实现 | 全部新验证待后续，默认不触发功能 |
| 独立 Panel 仓库 | 本轮不在该仓库做产品或审查修改 | `codeshell-panel-apps` 需独立任务分支和其仓库约定 |

只读格式规范核验采用官方 CommonMark/GFM、Git、W3C、RFC、Microsoft 和 Slack 文档，具体链接放在相关问题旁。没有通过网上文本反推 fake 服务真的执行过行为。

产品源码始终只读；本轮仅添加本审查目录。没有宣称 clean build、全仓 typecheck/lint、完整测试集或发布验收通过。所有实际 Bun 单元 shard 使用隔离 HOME/config 的 guarded runner；各 fixture 进一步使用纯函数、自有临时根/内存替身，避免真实网络和模型。
