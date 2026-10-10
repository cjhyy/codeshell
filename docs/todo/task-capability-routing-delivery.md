# 按任务选择初始工具

状态：2026-10-10 源码与受控本地验收已完成；尚未发行。

## 行为与所有权

现有 Run 开始时，根据当前任务和 preset 明确声明的词项规则，选择首轮展示的工具 schema。Core 只提供通用规则合同、匹配与预算机制；编码、ApplyPatch 和 LSP 的任务规则由 coding 能力包声明。无需额外模型请求，也不新增设置入口或侧边栏。

规则采用有界的本地词项匹配，不宣称完整自然语言理解或实际模型收益。普通第一方匹配路径保留协调、工具发现及现有 Goal／notes 控制，在当前 eligible catalog 中优先展示相关工具，初始数量目标为 8–15，ToolSearch 计入上限；可用工具不足时不补入未授权名称。没有匹配、规则无效或未声明规则时沿用 preset 原有初始集合；继承 preset 后额外明确声明的工具继续保留，不被第一方预算截断。

## 权限与生命周期

- 路由只改变初始 schema 加载顺序和集合，完整 registry、ToolSearch 发现目录、CapabilityService 与 Host catalog 均保留。没有通过关键词授予权限或静默缩小权限 allowlist。
- 先生成当前已授权且经过 availability、Profile、MCP、计划模式和 builtin overrides 过滤的目录，再求交选择；规则不能引入目录之外的工具。
- 显式 Run／behavior allowlist、无 ToolSearch 的目录及原有 eager preset 保持已有兼容路径。路由不能覆盖 preset 的工具安装或权限规则。
- 每个 Run 只路由一次。已经加载的工具继续沿 RunToolSurface 保持粘性，ToolSearch 选择仍从下一模型步骤生效；本步骤重试和 continuation 使用冻结快照。撤权立即优先于选择，Executor 原有检查与审批保留。
- 下次 Run 使用下一条任务重新判断；不跨 Session 持久化词项推断，不因 Run 中的工具结果或网页内容重新改写初始路由。
- 路由日志只记录规则 ID、原因、工具名和数量，不新增原始任务内容日志。任务本身仍沿既有 Session 与 transcript 合同保存。

## 验证

本地完成以下验证，均以进程退出码 0 为准：

- Guarded 匹配器分片 12 案、第一方及 coding preset 分片 37 案、实际 Engine 分片 8 案、既有渐进工具面及架构回归分片 56 案，零失败、零跳过。覆盖排名、词边界、NFKC、无效规则回退、自动 ToolSearch 与 core 合计超预算的回退、预算与继承追加、可用性求交、显式 allowlist、eager 和 legacy 兼容。
- 副对话兼容分片 4 案通过：显式编辑任务保留 Write／Edit，经真实 ToolSearch 选择后下一步骤加载 Bash；两步均继续禁用 Agent。这个行为区分初始 schema 与执行权限。
- 既有优化实验室账本分片 22 案通过。崩溃夹具的父子进程共享已授权 grant 的受控时钟，避免持久写入与 100 毫秒墙钟租约竞速；保持原 TTL、真实 SIGKILL、租约过期后换主、未知支出与防重复操作断言。生产租约机制不变。
- `bun run test:task-routing` 使用真实编译包及合成 OpenAI-compatible HTTP 响应，实际执行本地 Read、绑定资料集 ReadSource 和 coding ApplyPatch。三个任务首轮分别为 11／15／13 个工具；同批 inactive 调用在审批、hook 和 handler 前拒绝，SDK retry 使用同一 schema，下一 Run 重新路由且不继承前一次 ToolSearch 选择，完整 catalog 保留。
- 该 Node consumer 在 Core 导入前限定网络到本地精确 origin；27 次 HTTP 请求中 16 次为主工具请求、11 次为无工具辅助请求。两个越界负探针被拒绝。六个路由事件不含任务 canary；五个 Engine、HTTP server 和临时 fixture 完成收尾后才输出成功报告。私有 HOME 与网络补丁属于测试隔离，不等于 OS 沙箱。
- `bun run test:deferred-tools` 原有编译 SDK consumer 通过；package-release 检查通过 9 个 tarball、47 个类型入口；完整工作区构建与类型检查、格式检查、lint 基线、engine-bypass 和 workflow test paths 检查通过。新增编译 consumer 已纳入 CI。

真实模型工具选择质量、长程缓存和费用收益仍需独立真实评测；本地合成请求不代替真实 provider 验收。
