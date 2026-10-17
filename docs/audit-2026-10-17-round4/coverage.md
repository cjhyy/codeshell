# 本批范围与后续缺口

本批从冻结源码 `4ee32f28f78b8315112cca77cfc22b2f2f80ced6` 重新阅读。旧材料只用于查重；以下为本批范围，不能代表全仓累计覆盖率。当前目标是持续审查，尚未完成。

| 范围 | 本批实际覆盖 | 未覆盖 / 边界 |
| --- | --- | --- |
| Core context | 七个生产叶文件；run context、budget、summary/TurnLoop/transcript/MCP 选择性调用链；真实 manager/TurnLoop + fake model、纯转换 | 真实模型/API、全 Engine/Host、真实 MCP、所有压缩策略组合、压力/跨进程 |
| Core settings | manager/schema/personalization/migration/recovery/feature/schema-export；真实自有目录 YAML/JSON 与 Config tool/atomic writer 对照 | 完整 migration combinations、真实 TUI/Electron/协议写入、跨进程竞争、故障注入、账户/认证方向 |
| Coding LSP | client/manager/root-path/servers/tool 与注册、文件 URL；真实工具/manager + 内存 client；真实临时源文件 | 真实语言服务器/安装、watcher、GUI、生命周期旧失败方向、Windows/UNC、网络、超时分支 |
| TUI CLI | command registry/run/runs/input/output/options 和普通 slash commands 的相邻源码 | 四项候选测试导入前失败，全部跳过；完整 Ink/PTY/交互未执行，用户 HOME 未使用 |
| Core logging | logger/session-recorder 相邻源码；真实轮转与读取、自有 tmp/单 bucket 控制 | dev recorder 跨日 fixture 路径控制失败后跳过；真实应用启动、真实时钟跨日、所有日志消费者 |
| 其他包与独立仓库 | 本批没有新增深度审查；保留前批冻结记录用于查重 | Desktop、Server、Web、Host、Link、Pet、Chat、CDP、browser-devtools、Arena/Lab 等仍有大量未覆盖分支；独立 codeshell-panel-apps 未开展全仓审查 |

本批没有产品修复，没有 clean build、全仓 test/typecheck/lint、真实平台或发布验收声明。测试通过的是错误行为断言与正常对照；不意味着 bug 已修复。源码 manifest 的哈希相等只证明冻结快照一致，不等于逐行深度审阅所有列入文件。

后续可继续普通数据/调用链审查，并使用 [候选与跳过](candidates-and-skips.md) 避免重试已失败方向和重复计数。现有各批问题可能随其他任务修复而变化，不能把历史发现数量直接相加当作当前剩余 bug 数。
