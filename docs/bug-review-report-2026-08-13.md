# CodeShell 持续 Bug Review 报告（2026-08-13）

## 范围与方法

本轮是在上一轮全面修复后的持续复查，重点检查失败原子性、跨进程竞争、IPC/网络权威边界，以及持久化文件的大小、链接和路径边界。每个改动都按“定位不变量 → 构造修复前失败的回归测试 → 修复根因 → 包级类型检查”闭环处理。

工作树在开始前已有大量本轮前序改动；复查全程没有 reset、覆盖、暂存、提交或推送。

## 本轮主要修复

### 1. 配置、信任与本地状态

- SettingsManager：项目 `.code-shell`、设置文件和迁移备份不再跟随链接；输入/输出 4MB 上限；迁移与写入保持原子。
- TrustStore、SessionTitles：加入有界无跟随读取、owner-only 原子写入和跨进程读改写锁。
- AutomationMemory：摘要与状态分别限额，拒绝链接 job/file，写入保持原子与私有权限。
- 浏览器策略：损坏、超额或链接配置改为 fail closed；域名规则和条目数量有界，自定义端口不再误伤 hostname 匹配。

### 2. Chat/IM 网关

- Chat 配置：文件、列表、字符串、并发数、webhook body 和 pending 队列全部有界；桌面端配置更新使用安全原子读改写。
- 单实例锁：锁记录有界、无跟随、严格校验 owner/token，失败创建会清理半成品。
- DeliveryQueue：消除持久化 spool 路径穿越；状态/单消息/目录扫描有界；enqueue 失败回滚；成功投递先保存终态再删除 payload；终态保存失败可重试且不阻塞队列。
- WeChat 登录：所有配置预检先于二维码、凭据和状态副作用；配置更新安全、原子且有界。
- Teams 会话引用：仅接受匹配 conversation 的 Teams 引用以及安全 HTTPS service URL，文件与条目均有限额。
- 服务定义：owner-only 原子写入，链接定义不再被误判为已安装，日志目录必须为真实目录。

### 3. Run、Session 与转录

- FileRunStore：run id、目录和子目录重新做真实路径约束；JSON/JSONL/日志按用途限额；目录扫描有界；日志无跟随追加。
- Heartbeat：64KB 有界严格解析，链接 run 目录/heartbeat 不再被读取、写入或删除，写入原子。
- SessionMemory：修复 session id 直接路径穿越；条目、文件、扫描和返回值有界；链接目录/文件 fail closed。
- 原始/折叠转录和外部运行时状态：按 tail/record 限额读取，拒绝链接，并严格验证反序列化状态。

### 4. Panel App、Pet 与数字人

- Panel App KV：修复普通对象原型键污染/继承读取；改用 null-prototype 数据对象与 own-property 查询；配额在读取前执行；链接 namespace/file 拒绝；跨进程锁覆盖重新读取和保存。
- Pet receipt、work inbox、long task：统一复用有界 JSON 存储；输出原子、owner-only；active task 也受总量限制，最新 flush 失败不会被旧成功静默掩盖。
- 数字人团队：team 文件 64KB 限额、无跟随打开、目录流式枚举上限；保存与删除在跨进程锁内完成。

### 5. 公共并发与自动整理状态

- 通用 `mutateJsonFile`：在已有跨进程锁基础上增加输入/输出双向字节上限、文件类型检查和 `O_NOFOLLOW` 读取；保护其所有调用方，而非只补一个入口。
- AutoDream：状态 64KB 限额；计数必须为非负安全整数并防溢出；时间戳重新验证；链接状态只读为空且拒绝修改，避免读取或覆盖外部目标。

### 6. 前序复查中继续确认的高风险边界

- DriveAgent 改为先注册再启动，修复同步回调/立即退出造成的孤儿任务。
- Room、附件、上传、配对与可信设备状态补齐 authoritative id、路径、链接、大小和历史上限。
- 外部 runtime、CC approval、GitHub skill review/update、sources、skills/agents/MCP 和 renderer/main IPC 均在执行点重新核对权威 owner/cwd/path，而不是信任 renderer 提供的派生路径。
- Cron/Goal 数字参数、队列和持久化状态加入安全整数及合理上限，避免 Infinity、负数和溢出破坏生命周期。

### 7. 安装目录、模型、主题与浏览器状态

- Panel App registry：4MB 有界无跟随读取；普通损坏可从发现列表隔离，但写操作拒绝覆盖损坏/链接状态；写入原子且 owner-only。
- Panel App installer：manifest、declared skill 与 review digest 的实际读取均在打开句柄后重新 `fstat`，堵住扫描后替换成超大文件的 TOCTOU。
- Workspace profile / Git 数字人目录：profile、manifest 与目录扫描有界；远程仓库提交的链接 manifest/profile 不会被读取；仓库列表严格去重并限制为 32 项。
- Model catalog：provider/model/param/option/text/number 全部有 schema 上限；目录文件 4MB 有界；编辑在跨进程锁内重读，备份后缀防路径注入，备份排他创建，保存 owner-only 原子替换。
- Theme installer：manifest/registry 有界无跟随；损坏 registry fail closed；registry 锁内更新，真实 8 进程并发安装不丢条目。
- Plugin marketplaces / installed plugins：注册表有界无跟随、严格结构验证，append/remove 与 Hook/MCP 审批均在跨进程锁内重新读取后保存；canonical manifest 不能通过链接贡献自动化模板。
- Plugin 重装：成功后完整性信息回写与失败回滚恢复均改为锁内原子合并，不再用旧快照覆盖同时安装的其他插件记录。
- Chrome native bridge：状态文件 64KB、严格 token/port/pid、无跟随读取与 owner-only 原子写；写状态失败会关闭监听并回滚内存状态。
- CredentialStore 与旧凭据迁移：真实父目录、32MB 限额、无跟随读取、锁内原子写；链接凭据文件不会泄露或被替换。

## 回归验证

本轮各批次均运行相关回归测试及受影响 package 的 TypeScript 检查。最后阶段新增验证包括：

- Panel App storage：5 tests passed。
- 数字人团队：8 tests passed。
- 通用文件互斥、AutoDream、来源目录、数字人仓库并发：26 tests passed，包含 144 次真实子进程竞争写入。
- Settings、Trust、AutomationMemory、Browser policy、Chat 配置/队列/登录/Teams/服务管理、Run/Heartbeat/SessionMemory/Pet 等分批测试均通过。
- Core、Chat、Desktop 在对应批次的 package typecheck 均通过。
- `git diff --check` 通过。
- 后续持续复查新增的模型、主题、插件、Panel App、Chrome native 与凭据批次测试均通过，并再次通过 Core/Desktop 类型检查与 ESLint 局部检查。
- 全部 11 个 workspace TypeScript 检查通过。
- 全量构建与 Desktop main/preload/renderer/mobile 四段构建通过。
- ESLint 为 0 errors；warning 基线由 131 降至 122，`lint:baseline` 和 `lint:engine-bypass` 通过。
- 最终全仓测试：**8874 pass、43 skip、0 fail**，共 8917 tests / 1226 files / 24839 次断言，耗时 285.84s。

## 后续建议

1. 把“有界、无跟随、原子、owner-only、跨进程锁内重读”沉淀成 core 公共存储模块，逐步替换仍散落的直接 `readFile + JSON.parse`。
2. 为 IPC handler 建立统一 authoritative-resource resolver，减少每个入口手写 cwd/session/owner 校验的遗漏概率。
3. 在 CI 加入持久化安全测试矩阵：oversized、symlink、directory-as-file、corrupt JSON、并发进程、写入失败和重启恢复。
4. 大型全仓修复分批提交，按边界（存储、IPC、网络、生命周期）拆分，便于审阅和回滚。
