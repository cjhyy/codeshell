# CodeShell Bug 修复执行报告（2026-08-12）

本轮按 [`docs/bug-fixing-guide.md`](./bug-fixing-guide.md) 连续排查约 3 小时。范围覆盖外部运行时、workspace/IPC、持久化、撤销/重做、移动远程认证与本地隐私文件。所有修改保留在当前工作树中；没有提交、暂存、重置或覆盖开始前已有的未提交工作。

## 结论

- 修复了多组会造成状态串线、越权访问、崩溃后数据截断、并发丢更新、凭据权限过宽和撤销错误的缺陷。
- 为修复补充了故障注入、并发、跨进程、符号链接、损坏文件、生命周期竞态和权限回归测试。
- 最终全量测试、全部 workspace 类型检查、架构边界检查、workflow 路径检查和 `git diff --check` 均通过。
- 全仓 lint 为 0 error、125 warning；warning 属于仓库现有基线，本轮新增/触及文件没有新增 lint error。

## 主要修复

### 1. 外部 Agent 运行时与 renderer 状态

- 同一 session 的 turn 改为串行执行，阻止并发消息互相覆盖。
- stop、退出、迟到事件和缺失终止事件统一进入单一终态；已经结束的 session 不再被迟到事件“复活”。
- session 所有权绑定到发起窗口；审批、停止和事件只路由到正确 owner，窗口销毁时清理所属运行。
- 规范化 provider session id 和模型切换，避免 UI 仍向旧 session/旧模型发送消息。
- renderer 发送链增加 session epoch/序列化，避免快速切换会话导致结果串线。

### 2. Workspace 与 IPC 授权

- workspace 根目录由主进程权威状态决定，不再信任 renderer 任意传入路径。
- settings、trust 和项目相关 IPC 只接受已注册 recent project、持久化 session workspace 或明确允许的 no-repo 路径。
- worktree 成员关系、未知 session、损坏 workspace 状态均 fail-closed。
- 修复 DriveAgent 前台租约、重复 writer、自动隔离失败后错误回退以及 handoff 状态问题。

### 3. 持久化、崩溃恢复与并发

- Session、Run、Transcript、Settings、Trust、Title、Agent、Pet、Automation、Source catalog、外部 agent session 等写入改为唯一临时文件 + 原子 rename + finally 清理。
- 对共享 JSON 的 read-modify-write 增加跨进程锁，并在锁内重新读取，避免并发 writer 丢更新。
- JSONL 尾部截断可修复；损坏快照/记录隔离，不再因一条坏记录丢弃全部历史。
- 用户数据目录收紧为 `0700`，包含 prompt、token、secretHash、transcript 等文件收紧为 `0600`，并修复旧文件权限。
- `CODE_SHELL_HOME` 覆盖在 trust、title、window state 等冷路径中保持一致。

### 4. 撤销/重做正确性与安全

- 最新轮选择同时考虑“修改文件”和“仅新建文件”；不会因最新轮只有新文件而错误撤销更早一轮。
- 删除文件的 post-turn “不存在”状态可被 redo 正确重放。
- 返回的 snapshot/redo record 改为值副本；调用方篡改对象不能改写内部历史。
- undo/redo 只接受与权威历史精确匹配的记录，拒绝伪造路径、外部 backup 和符号链接目标。
- 父目录被替换为符号链接时拒绝恢复，避免写到原路径之外。
- redo 捕获全部成功后才修改文件；部分捕获失败会清理半成品，不产生虚假 redo。
- redo 应用失败保留材料以便重试；不会错误消费唯一恢复点。
- 文件内容恢复时同时恢复原 POSIX mode，可执行脚本不再因私有 backup 的 `0600` 权限丢失执行位。
- 旧版无 `turnSeq` 的历史仍能 undo、重启加载并 redo。

### 5. 移动远程与认证边界

- WebSocket JSON 增加完整运行时 DTO 校验；`null`、未知事件、错误字段类型和畸形特权事件不会进入桌面调度。
- 对消息、路径、标识符、history limit、附件数量与大小设置入口上限，并与上传/物化业务常量共享。
- 访问口令文件保存改为原子 `0600`；损坏记录安全拒绝，未来时间戳和异常 token 不再通过验证。
- 口令限制为 4–256 字符，核心、IPC 和 UI 三层一致；无效/超长输入不进入高成本 scrypt，但仍计入锁定。
- 口令锁定次数、锁定时长与 token 有效期必须是正安全整数，错误配置不再静默关闭保护。
- 受信设备文件改为原子 `0600`，严格验证结构与重复 id；损坏数据明确失败且绝不被静默覆盖。
- 设备增删改与鉴权时间刷新在跨进程锁内重读并原子提交，多实例同时配对不再丢设备记录。
- 配对 token 与设备持久化改成同步提交语义：存储失败不消费 token；成功只消费一次；跨过期毫秒不会出现“设备已写入但客户端收到失败”。
- 配对 TTL/时钟拒绝 NaN、Infinity、溢出和非正值，避免比较失效产生永久 token；异步桌面调度异常被转换为受控 WebSocket 错误，不再形成未处理 rejection。
- 移动 room 元数据和 message JSONL 加入私有权限、原子写与断尾边界修复。

### 6. 其他修复

- 文件 run store、session manager、transcript writer 的初始写入失败与遗留权限处理更可靠。
- source catalog 的并发更新不再丢条目。
- cron、pet metadata/work memory/receipt/long task、window state 等固定 `.tmp` 竞争和残留问题已修复。
- 内置能力安装路径与工具注册结果协议补齐测试，避免能力安装结果与实际状态不一致。

## 验证证据

最终执行并通过：

```bash
bun test
bun run typecheck:workspaces
bun run lint
bun run lint:engine-bypass
bun run lint:workflow-test-paths
git diff --check
```

另外按模块运行过：

- core session/run 相关测试：220 项通过。
- desktop pet main 测试：335 项通过。
- automation 测试：135 项通过。
- undo/redo 定向测试：46 项通过。
- 移动认证、配对、设备、上传、附件、remote host 定向测试均通过。
- source catalog 24 进程并发写回归通过。
- core、server、desktop、TUI 的独立 typecheck/build 链通过。

## 建议人工 smoke

自动化已覆盖数据与协议不变量，仍建议在真实桌面 UI 做以下短 smoke：

1. 快速切换两个外部 runtime session 并连续发送消息，确认输出不串线，停止后无迟到内容。
2. 在同一轮仅新建一个文件，点击 Undo/Redo；再测试仅删除一个可执行脚本，确认内容与执行位往返。
3. 启动移动 LAN/tunnel，配对手机，发送小图与大图，修改访问口令后确认旧 cookie 失效。
4. 同时打开两个桌面窗口，确认 session、审批、workspace settings 与停止操作保持窗口隔离。

## 工作树说明

开始时工作树已包含用户未提交改动，本轮没有尝试按作者拆分或清理它们。交付前应由维护者按 `git diff` 逐块审阅，再决定如何分 commit；不建议一次性把全部 dirty files 直接提交。
