# 架构整改本机预览版 — 2026-11-10

用户最后指示：直接实施，不再调用 Codex 或 CC，先出一版。此交付是可运行的 macOS arm64 本机预览包；全量 CI 验收与受保护分支集成另行跟进。

## 交付

- 版本：`0.9.53-architecture.1`。
- ZIP：`/Users/admin/Documents/CodeShellBuilds/architecture-preview-20261110/CodeShell-0.9.53-architecture.1-mac-arm64.zip`。
- 应用：`/Users/admin/Documents/CodeShellBuilds/architecture-preview-20261110/mac-arm64/code-shell.app`。
- 构建源码：`ece147bb754a8c3a52a1bdbb3fe44edceb7efd23`。其后的 `8ad1114ec` 只补齐 H1 的 Server 导出契约测试，未改变包内生产代码。
- 构建回执：预览包目录中的 `build-receipt.json`；实际应用 UI 验收：`ui-acceptance/launcher-receipt.json`。
- 持久源码工作区：`/Users/admin/Documents/CodeShellBuilds/architecture-review-20261110`，分支 `codex/architecture/direct-candidate-20261110`。

## 补齐的实施

Astra 交付的其余实现均保留。本次补齐了清单中剩余的 D2、E3 与 R1/R2 锁文件，因此 22 项均已有实施候选；这不表示全部 PR/CI 验收通过。

- `408ad2703`：Bun 重新生成锁文件，仅删除 arena/CDP 的 17 行条目，无依赖升级。
- `06ee8469e`（D2）：preload 暴露对象加入 `satisfies CodeshellApi`；修正实际 RunResult、外部取消的 undefined 返回、字符串 RPC ID、事件回调、记忆输入及 Panel digest 类型。初始 21 条诊断修复后，又发现并修复两个 spread API 的事件参数类型。账号功能的两条 main IPC 用共享参数/返回值表做编译约束，路由数不变。
- `ece147bb7`（E3）：先归档并校验全部 6676 个证据文件，再删除对应候选路径。原始 365232645 bytes，压缩归档 80063129 bytes，实际分布在 64 个含 evidence 的审计目录。审计报告、manifest 与 Git 历史保留；见 `architecture-review-e3-archive-20261110.md`。
- `8ad1114ec`：宿主全量测试发现 H1 新增的 `headlessWorkerEnv` 未加入旧的精确导出期望表；已修正并复验 32 项入口/worker 测试通过。

## 预览验收

- 根 build、桌面完整构建通过，包含原生 Computer Use helper、renderer、mobile 和 Chrome 扩展。
- 全部 12 个 workspace 类型检查通过。打包会 materialize workspace 包，打包后的重复私有类型诊断通过重新安装 frozen lockfile、恢复 workspace 链接后消除；未修改生产类型以压制诊断。
- lint：0 errors / 90 warnings，与既有基线一致；测试分片及 Engine bypass 护栏通过。
- D2 定向测试及三个全仓契约测试：39 pass / 0 fail。虚拟编译负向探针证明错误的账号 IPC 返回值被 TS2322 拒绝，无需改动磁盘源码。
- 原生 Server smoke 通过：本地模型 SSE、真实 worker、授权 WebSocket、持久化、停止、重启恢复与隔离关停。
- 实际打包 Main/preload/renderer UI 验收通过：浅/深色、390/768/1280 宽度、设置导航、重载及主题流程。应用完整树、asar 和托管 Node 校验通过；深度严格签名验证通过，确认临时 ad-hoc 签名；验收子进程全部退出。
- 预览应用未上传或公证，未合并 main；未进行生产发布。

## 全量测试仍在跟进

宿主的 38 分片扫描使用固定前序候选 `408ad2703`，日志位于：
`/Users/admin/Documents/个人学习/代码学习/codeshell-worktrees/architecture-review-delivery-20261110/host-validation/`。

截至本机预览交付，SDK 边界 10 项、core-engine 2456 项（3 skip）、core-rest 3363 项、rest 3510 项（3 skip）已完成且零失败。Desktop 初次 7103 pass / 73 skip / 1 fail；该失败来自把 Homebrew 动态链接 Node 复制到临时目录后缺少 libnode，不是生产代码改动。改用预览应用自带、校验通过的独立 Node，相关文件 3 项复验全过。Server 的 H1 导出期望遗漏已修正，相关 32 项复验通过。后续分片尚未全部结束，不能把这些分段结果合称全量通过，也不代表 14 项 required CI 已绿。

本次没有再次委派 agent 或启动 CC；主工作区和其他 Mimi worktree 的文件均未修改。原始任务清单保留，不伪造 PR 号或全验收完成标记。
