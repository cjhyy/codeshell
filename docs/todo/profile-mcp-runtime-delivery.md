# Profile MCP 运行时开关

本增量只把已有 MCP 能力开关接入 Core 执行路径，不新增服务器、账号、授权、导航入口或 Desktop 独占能力语义。当前为源码与本地受控验收，尚未发行，也不代替真实 MCP 服务验收。

每次 Run 开始，Engine 从未覆盖的 `config.mcpServers` 基线复制一份配置，并通过既有 `effectiveProjectOverrides` 读取 MCP 桶：显式 Session Profile 替代项目默认 Profile 快照，直接项目覆盖优先、本机覆盖最后。只改变已配置服务器的 `enabled`，未知名称不能创建服务器；`inherit` 恢复原始基线，不把上次 Run 的覆盖结果当成基线。Profile 声明仍只能打开已存在服务器，不增加资源或凭据权限。

连接、工具定义刷新、MCP 工具策略和 `allowedMcpServers` 使用同一 Run 快照。已注册工具、通用 `MCPTool`、`ReadMcpResource` 与资源枚举继续经既有 ToolExecutor 白名单。`ReadSource`／`ListSources` 的默认 MCP adapter 现在必须携带所属 Run 的原生 MCP binding 与白名单，并使用该 manager 和 workspace；缺少 binding 不再回退到全局 singleton。可注入 adapter factory 保持兼容，非 MCP adapter 不改行为。

`refreshRuntimeConfig` 保留原始下一 Run 配置，不再立即调用不带 Run context 的共享池 reconcile。这是有意的生命周期变化：当前 Run 不因重载失去连接或改变 MCP 工具面；下一 Run 的 `connectAll` 更新本 owner 的 desired scope，移除不再需要的连接，兄弟 Session 仍需要的连接保留。相同名称和 workspace 的 transport 参数替换仍沿用既有 manager 行为：已经连接的同 key transport 不会在此增量中强制重建，需要释放该 owner／连接后重连。没有提供任意外部 CLI 自有 MCP 配置或中途撤权的新合同。

## 验证

`tests/profile-mcp-runtime.test.ts` 在独立 guarded 子进程运行实际 Engine、纯内存 provider 和本地 stdio MCP 服务，其中六项实际 Engine 回归覆盖项目开关、on/off→inherit、Session／默认／项目／本机优先级、运行中重载与下一 Run 移除、共享池 owner 保留、通用与已注册工具拒绝、MCP source metadata/content 路径；另两项验证默认 adapter 缺 Run binding 拒绝与纯 snapshot 复制边界。fixture 在首次 Core import 前核真实私有 HOME／无继承凭据并执行八个 HTTP 拒绝探针；合成 stdio 子进程自行记录 PID／PPID／HOME hash 与两个 HTTP 拒绝探针。该 JS guard 不代表 OS 网络沙箱，也不宣称覆盖任意 raw socket 或未经管理的子进程。

相关原有 Profile、能力列表、共享池、热重载和 source tests 应一并保留。真实第三方接入继续按用户要求暂停。
