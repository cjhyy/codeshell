# Desktop 默认 Profile 切换影响预览

Desktop 项目设置的数字人区块和数字人页的“设为／取消项目默认”复用同一预览与确认流程，没有新增导航入口。显式 Session 数字人绑定选择器继续使用原有流程。

## 生效范围

- projectId 由 Main 解析为当前项目主目录；sessionId 由 Main 解析为 Session 已绑定的主目录，二者可以不同。Renderer 不提供可信路径。
- 只替换或删除该配置根的 settings.json 中 profile 子树，保留无关设置。现有显式 Session 绑定不改写。
- 同一配置根下未显式绑定 Profile 的普通工作 Session 在后续回合读取新默认。数字人主指令与 portable memory 的实际读取仍由既有每轮配置解析负责。
- 采用复用 withWebConfigurationMutation：存在当前任务时先返回 409，保存与现有 worker reload/通知期间阻止新任务进入。仅成功采用触发一次既有重载；不会额外派发 settings-changed。这不覆盖 legacy 直接 API、其他客户端或手工文件编辑。

## 预览与采用

预览仅读取配置、Profile 定义、发现清单与数据源绑定／凭据状态元数据。SettingsManager 保持 migration 的内存计算，但跳过备份与写回。预览不安装依赖、不执行工具版本探测，也不读取项目指令、记忆正文或解密凭据。依赖安装的既有确认流程结束后才生成最终预览。

预览显示 Profile 指令是否变化及长度、portable memory 挂载身份、现有能力配置开关差异、尚未发现的能力声明，以及数据源规则与项目绑定的实际交集。能力配置不代表已安装、已连接或已授权；MCP Profile overrides 尚未进入运行时 diskDefaults，故只称配置声明。Desktop 独占能力语义保持只处理已发现 Skills，不扩大到插件、MCP 或 Agent。

采用以 SHA-256 expectedRevision 比较 Profile 定义、当前默认、项目／本机直接覆盖、发现清单与数据源状态。Main 在 mutation gate 内重新解析目标；配置比较与 profile 子树写入共用现有项目 scope 锁。目标或配置变化返回 stale，界面刷新预览并要求再次确认，不静默转写新根目录。取消、任务忙、旧预览均不写 Profile，也不触发重载。异步返回属于旧 UI 目标时丢弃。

旧默认定义缺失、损坏或不能安全读取时，保留不可用身份、指令长度和记忆挂载显示未知、数据源访问为 deny-all。当前目标库加载完成且没有有效 active 条目时，共享 hook 只读检查一次，并在两个现有区块提供“取消项目默认”恢复动作，空库也可退出。打开恢复确认会重新预览；旧定义被修复后，先前 revision 失效。候选定义始终严格验证。

## 回归入口

- Core switch-plan 测试：既有 activation 规则、直接覆盖优先、取消默认的真实 baseline fallback、缺失声明分离。
- Main profile-switch 测试：真实 IPC、项目／Session authority 的 gate 等待竞态、stale 与 busy 零写／零重载、无关设置与显式绑定保留、legacy migration fixture 全树零写、数据源求交与敏感字段不出 DTO。
- Electron digital-human E2E：真实 preload/IPC 下两个入口同一预览、取消零写、旧定义预览需第二次确认、取消默认 fallback；私有 HOME、无账号／模型，Core 导入前及 worker 使用 deny-all 网络 guard。

此功能独立于 0.9.28 安全／恢复发行，按后续 PR 整合。
