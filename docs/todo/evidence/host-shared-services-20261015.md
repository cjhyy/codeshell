# Host 1.2a 共享服务首轮交付（2026-10-15，历史记录）

**首轮限制已 resolved：**主控已正常宿主补交 `b497f6d01`、`cd5489539`、`5d891c836fe99f67f104c96646d6d4b5d59ac2ed` 并建立 draft PR190。bg_5u1l8 已通过本记录原待验的完整 package-release、84 项真实 HTTP/账本契约、完整 typecheck 14 workspace、Desktop main 与 Node identity。CC 已确认 PR188 原三 P2 closed。下列命令和限制保留为当时记录，不再表示旧 head 待验/未提交；当前修复、提交和宿主补验以[本轮复审清单](host-shared-services-cc-review-20261015.md)为准，旧 head 证据不替代新代码验证。

范围仅第 8a（输出回放除外）和 PR188 的三个非阻断 P2。没有继续 9–14 或 S2/S3，没有改 main/其他任务树，没有调用 Claude 或其他写入 worker。只读辅助审计不替代主控独立 CC review。

- base：`19bc2167402da53caeace26ac69207822c166448`。
- 子任务返回时 HEAD 仍为 base：沙箱拒绝创建本工作树共享 Git 元数据的 `index.lock`。主控在独立 CC review 前使用正常宿主 Git 按下列三组补交本批改动；审查消息以实际固定 base/head 为准。
- branch：`codex/host/shared-services-20261015`；开始时 clean；主控此前已成功冻结安装 2095 packages。本批未改任何依赖 manifest/lock。
- 实现与可运行验证已完成；正常宿主真实 HTTP 合同、完整 package-release 的监听段、Git 提交与独立 CC review 待主控接续。第 8 整体和 S1 均未完成。

## 生产入口与删除的重复实现

| 领域 | 真实生产调用 | 迁移/保留边界 |
| --- | --- | --- |
| Skills | Desktop `index.ts skills:list/read/uninstall → skills-service.listSkills → Host.readSkillInventory`；Hub `skills-management.snapshot/listed → 同一 inventory`；重名与来源预览只需 Core definitions scan | 删除两边 effective disabled + all/enabled 扫描组合。Core `/internal/skills` 安装/下载/bundle/revision 未复制。Desktop 精确 renderer target/listed path/safe-read grants；Hub owner、项目独占修改、revision/review token、写前写后授权、revoke/mutation gate 仍在 adapter。 |
| MCP | Desktop `mcp:probe → mcp-probe-service → Host.probeMcp`；Hub `mcp-configuration → 兼容 mcp-probe → 同一 Host.probeMcp` | 删除 Desktop 短连接和 Hub 的实际探测/分页循环。Host 统一 transport、8 页/100 preview、重复 cursor、2 MiB总量、timeout/cancel、typed errors/脱敏。Core `/internal createMcpProbeConnection` 只提供 connect/listTools/close，并封装 SDK、512 KiB stdio帧及进程组回收；Host 不直接依赖 SDK。Desktop 保留 8 s、60 s cache/DTO/logger/OAuth resolver，cache 显式绑定 workspace/config，无授权版本的 credential/env 引用不缓存；IPC 兼容追加配置 target，Main 解析授权 cwd。Hub 的 workspace/owner 并发/HTTPdisconnect/revoke→signal 保留。 |
| Model | Hub `configuration.ts → Host.probeConfiguredModel`；旧 `hub/model-probe` 仅兼容转导出 | 这是 Hub 独有的 Core-only 连接测试 ownership 迁移，未虚称三份算法去重。Core model-fetcher 与 Desktop metadata 未改；保持最多一次物理请求、拒 redirect、1 MiB、32 tokens、无工具、timeout/cancel/脱敏。未新增 Desktop 付费测试入口。 |
| Session FS | Desktop `sessions:listDisk → server/storage → sessions-service.listDiskSessions → Host.async scan/read`；Hub `session-management.list/readHubSessionState/文件快照读取 → Host.scan/read + Core.internal.listSessionEntries` | Host 共享 safe ID、显式 root、有界 ordinary-file read、拒目录/文件 symlink、dev/ino重验与候选扫描。Core 原 SessionManager.list 算法原地抽 internal 窄函数，公开签名/默认行为保持；Hub 注入 Host storage，Core 不反向依赖 Host。Desktop 按目录 mtime/origin/legacy parent/missing cwd；Hub 按 transcript/state mtime、workspace/search/custom title/cursor，CAS/running guard 保留。默认根只用 Core.sessionsRoot。 |

未迁 Desktop SessionCatalogStore/UI catalog、transcript fold、export 格式、output journal、snapshot、seq/epoch。HostRuntime 同步生命周期不变，探测/异步文件方法显式 async 并关闭句柄。1.2b 输出回放等待 v2 journal cursor 与 stateVersion 两类续传。

兼容收尾：公开 Session adapter 先解析调用方显式传入的相对 root，Host 仍只接受绝对 root；默认 scanner 先调用 Core.sessionsRoot（含测试守卫）再规范化，相对 CODE_SHELL_HOME 也保持兼容。Desktop 同目录 mtime 的排序与 cursor 统一 localeCompare，修复混合大小写 ID 漏页，并用两端入口测试前页删除。

Core stable public SDK 与 extension 导出预算未变。Core internal 预算 113→115 计的是 export 语句；本批两个窄服务边界新增两个语句、三个 runtime 值：`McpProbeConnectionError`、`createMcpProbeConnection`、`listSessionEntries`。完整 runtime 清单已在本轮精确批准三者，不能将两个边界误写成两个 runtime 值。Host 运行依赖仍只有 Core 与 Node builtin。

## P2 修复

1. `ExternalAccountingOwnershipError` 保留所有 adopt owner/scope/namespace 校验，fail-closed 且不改历史账本/费用。拒绝时提示 Native 运行一轮重建当前目录归属；同一 wire 失败不会把健康 CLI 永久置 faulted。测试迁移目录、非法 reference、多次提交、原账本/会话 costState 不变、修复后同 provider 重试。
2. renderer RPC catch 只以本次 launch generation、bucket、clientMessageId 和未在前次集合内的 runId completed projection 判断已发送终态。当前已 stream error/terminal 或跨窗口 abort 不再重复终态/toast/sound；纯 RPC、新一次真实失败与旧 launch settlement 均有真实 hook/reducer 回归。未改 Engine 生命周期或吞掉任意 RPC 异常。
3. reminder 注释与 recorder.operationIntentId 对齐：沿用最近真实用户 intent，不新开 write slot；没有真实用户消息才空 origin。现有真实 recorder/controller 的去重、conflict 与首条 injected 无写授权断言保持。

## 验证结果

最终两组共 **341 pass / 0 fail / 0 skipped，1300 assertions，30 文件**。补充身份/费用/权限收尾组为 21 pass / 0 fail、146 assertions（与两组重叠，不重复累加）。

所有工具命令均显式 workdir 为本工作树。Bun 1.3.11 / Node 25.8.1。所有单测经 guarded runner 隔离 HOME/应用状态、清凭据；网络 fixture 在 import Core/Host 前安装 exact-origin guard，stdio worker 也在接收请求前拒网；没有真实模型、付费服务或操作者 MCP 账户调用。

| 命令/范围 | 结果 |
| --- | --- |
| `bun run build`（首次先构建 Core/Host，再下游） | exit 0。 |
| 最初 P2 shard，3 文件 | 27 pass / 0 fail / 0 skipped，158 assertions。 |
| 完整 `bun run typecheck` | exit 0，完整根构建与 14 个 workspace，包含 Desktop main/preload/renderer/mobile 与 Web SPA；相对 root/cursor 收尾后完整重跑亦 exit 0。 |
| `bun run --cwd packages/desktop build:main` | exit 0，实际 Electron main bundle（19.4 MB）；没有原生 GUI/签名/真机验收声明。 |
| 最终核心 shard（下方 24 文件） | 257 pass / 0 fail / 0 skipped，942 assertions；含 inprocess unsupported、混合大小写同 mtime cursor、相对 root/CODE_SHELL_HOME 与 Hub revision/revoke/mutation gate。 |
| renderer/HTTP transport/Node identity shard（下方 6 文件） | 84 pass / 0 fail / 0 skipped，358 assertions。 |
| `node scripts/run-isolated-node-smoke.mjs scripts/smoke-host-shared-session-files.mjs` | exit 0。Node 验 Host 导出、Core stable 不泄露新 internal、sync/async × directory/file 四种读取中身份替换及失败后句柄关闭。 |
| targeted ESLint（所有修改/新增 TS/TSX/MJS） | exit 0，最终 0 errors / 0 warnings。 |
| `prettier --check`（44 个任务源码文件） | exit 0。 |
| `bun run lint:engine-bypass` | exit 0。 |
| `bun run lint:workflow-test-paths` | exit 0，20 个 workflow 路径存在。 |
| 架构预算/包边界/发布清单 | 已包含最终核心 shard；通过。 |
| `git diff --check` | 通过。 |
| `bun run test:package-release` | exit 1，仅受限段未过：10 包 clean build/pack/extract、48 个 strict NodeNext 声明入口、46 个 runtime imports 和 strict published owner-auth consumer 编译成功；随后 packed owner auth HTTP lifecycle 在 listen 127.0.0.1 报 EPERM；后续 uploaded-document consumer 未执行。未与任何读 dist 检查并发。 |
| 原真实 HTTP 契约（下方 6 文件） | 16 pass / 68 fail / 0 skipped，82 assertions；68 项均在监听阶段失败，未用 skip/放宽断言替代。需正常宿主原样补跑。 |
| Git 暂存/提交 | `git add` 在共享 `.git/worktrees/host-shared-services-20261015/index.lock` 报 Operation not permitted；随后 commit 未执行。不提升/绕过，未 push/merge/发布。 |

中途失败已修复并重验：依赖尚未构建导致 Core import 缺失；fixture plugin 路径未放在真实 `.code-shell/plugins/cache`、非法 revision/body 提前被正确拒绝；Core internal 新窄入口预算需显式说明；Bun 对 builtin monkeypatch 不刷新 ESM binding，身份替换断言改走已有隔离 Node launcher。上述不等同于将失败断言跳过。最初大 shard 的 270 pass / 4 fail 中，三项为这些测试/预算问题，均已解决；剩余 ledger 的真实 HTTP 监听失败纳入上表受限契约组。

必要源码检查的实际调用（工作目录同上）：`bunx --no-install eslint <全部 44 个修改/新增 TS/TSX/MJS 精确路径>`、`bunx --no-install prettier --check <同 44 路径>`；路径取本树 `git diff --name-only` 与 `git ls-files --others --exclude-standard` 的源码交集，未扫描其他工作树或操作其文件。`bun run lint:engine-bypass`、`bun run lint:workflow-test-paths`、`git diff --check` 也均已执行。

原始日志在本机 `/private/tmp/codeshell-shared-{unit-final,renderer,http-restricted,typecheck-final,desktop-build,package-release,final-boundaries}.log`。本记录不把其他批次宿主成功当作本批 HTTP 已通过，也不把 transport 注入 fixture 当作真实 TCP 验收。

## 完整最终分组命令

```sh
TASK='/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/host-shared-services-20261015'
(cd "$TASK" && node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/host/src/runtime.test.ts \
  packages/host/src/services/mcp-probe.integration.test.ts \
  packages/host/src/services/model-connection-probe.test.ts \
  packages/desktop/src/main/skill-inventory.integration.test.ts \
  packages/desktop/src/main/skills-service.test.ts \
  packages/desktop/src/main/safe-read.test.ts \
  packages/desktop/src/main/mcp-probe-service.test.ts \
  packages/desktop/src/main/external-runtime-operations.test.ts \
  packages/desktop/src/main/external-runtime-service.operations.test.ts \
  packages/desktop/src/main/external-runtime-state.test.ts \
  packages/server/src/hub/session-files.integration.test.ts \
  packages/server/src/sessions-service.disk.test.ts \
  packages/server/src/sessions-service.home.test.ts \
  packages/server/src/sessions-service.archive-race.test.ts \
  packages/core/src/session/session-manager.list-filter.test.ts \
  packages/core/src/session/session-manager.home.test.ts \
  packages/core/src/skills/scanner.allowlist.test.ts \
  packages/core/src/engine/engine.init-lifecycle.test.ts \
  packages/core/src/engine/run-finalize.test.ts \
  tests/skills-disabled.test.ts \
  tests/session-id-validation.test.ts \
  tests/architecture-budgets.test.ts \
  tests/package-boundaries.test.ts \
  tests/publish-release-packages.test.ts)

(cd "$TASK" && node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/host/src/services/session-files.test.ts \
  packages/host/src/services/mcp-probe.http-transport.test.ts \
  packages/desktop/src/renderer/app/useRunController.launch.test.tsx \
  packages/desktop/src/renderer/app/useHostSubscriptions.test.tsx \
  packages/desktop/src/renderer/settings/McpSection.lifecycle.test.tsx \
  packages/desktop/src/main/renderer-configuration-authority.test.ts)

```

补充收尾命令（21 pass，重叠项不加总）：

```sh
(cd "$TASK" && node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/desktop/src/main/skill-inventory.integration.test.ts \
  packages/desktop/src/main/external-runtime-operations.test.ts \
  packages/server/src/hub/session-files.integration.test.ts \
  packages/host/src/services/session-files.test.ts)
```

## 正常宿主必须补跑

先确认仍在本任务分支，保留其他工作树状态。依赖 manifest/lock 未改；主控原冻结安装保持有效。以下 package-release 会清 dist，必须完成后再执行其他读 dist 检查；不要并行。

```sh
TASK='/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/host-shared-services-20261015'
git -C "$TASK" branch --show-current
bun run --cwd "$TASK" test:package-release
(cd "$TASK" && node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/server/src/hub/model-probe.test.ts \
  packages/server/src/hub/mcp-configuration.test.ts \
  packages/server/src/hub/skills-management.test.ts \
  packages/server/src/hub/session-management.test.ts \
  packages/server/src/hub/configuration.test.ts \
  packages/core/src/cost-ledger/ledger.test.ts)

# 完整 package-release 成功后，在最终 checkout 重验：
bun run --cwd "$TASK" typecheck
bun run --cwd "$TASK/packages/desktop" build:main
(cd "$TASK" && node scripts/run-isolated-node-smoke.mjs scripts/smoke-host-shared-session-files.mjs)
```

没有安排 Electron UI、Chromium、原生 Windows/Linux、签名 App 或真实第三方账户测试；本批不以 fixture 声称这些验收已完成。Git 权限和监听受限是本次沙箱限制，不是请求批准或后续开发范围。

## 正常宿主精确提交命令（未执行）

逐组仅暂存本批路径；不要 `git add -A`，不要更改 main 或其他工作树。提交后将实际 newhead 填回主控 review 消息。本记录在沙箱内 newhead 仍为 base。

```sh
TASK='/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/host-shared-services-20261015'
git -C "$TASK" add -- \
  packages/desktop/src/main/external-runtime-operations.ts \
  packages/desktop/src/main/external-runtime-operations.test.ts \
  packages/desktop/src/main/external-runtime-service.ts \
  packages/desktop/src/main/external-runtime-service.operations.test.ts \
  packages/desktop/src/renderer/App.tsx \
  packages/desktop/src/renderer/app/useRunController.ts \
  packages/desktop/src/renderer/app/useRunController.launch.test.tsx
git -C "$TASK" commit -m 'fix(desktop): keep accounting recovery and run failure display scoped'

git -C "$TASK" add -- \
  packages/core/src/cost-ledger/ledger.test.ts \
  packages/core/src/index.internal.ts \
  packages/core/src/session/session-manager.ts \
  packages/core/src/tool-system/mcp-probe-connection.ts \
  packages/desktop/src/main/index.ts \
  packages/desktop/src/main/mcp-probe-service.ts \
  packages/desktop/src/main/skill-inventory.integration.test.ts \
  packages/desktop/src/main/skills-service.ts \
  packages/desktop/src/preload/index.ts \
  packages/desktop/src/preload/types.d.ts \
  packages/desktop/src/renderer/mcp/McpView.tsx \
  packages/desktop/src/renderer/settings/McpSection.lifecycle.fixture.tsx \
  packages/desktop/src/renderer/settings/McpSection.tsx \
  packages/host/src/index.ts \
  packages/host/src/services/mcp-probe.http-transport.test.ts \
  packages/host/src/services/mcp-probe.integration.test.ts \
  packages/host/src/services/mcp-probe.ts \
  packages/host/src/services/model-connection-probe.test.ts \
  packages/host/src/services/model-connection-probe.ts \
  packages/host/src/services/session-files.test.ts \
  packages/host/src/services/session-files.ts \
  packages/host/src/services/skill-inventory.ts \
  packages/server/src/hub/configuration.test.ts \
  packages/server/src/hub/configuration.ts \
  packages/server/src/hub/mcp-configuration.test.ts \
  packages/server/src/hub/mcp-probe.ts \
  packages/server/src/hub/model-probe.test.ts \
  packages/server/src/hub/model-probe.ts \
  packages/server/src/hub/session-files.integration.test.ts \
  packages/server/src/hub/session-management.test.ts \
  packages/server/src/hub/session-management.ts \
  packages/server/src/hub/skills-management.test.ts \
  packages/server/src/hub/skills-management.ts \
  packages/server/src/sessions-service.ts \
  scripts/smoke-host-shared-session-files.mjs \
  tests/architecture-budgets.test.ts \
  tests/helpers/network-fixture.ts
git -C "$TASK" commit -m 'feat(host): share skill inventory probes and safe session files'

git -C "$TASK" add -- \
  CHANGELOG.md \
  TODO.md \
  docs/architecture/16-platform-consolidation.md \
  docs/todo/evidence/host-shared-services-20261015.md \
  docs/todo/platform-first-version-plan.md \
  docs/todo/platform-pr188-followups.md \
  packages/host/README.md
git -C "$TASK" commit -m 'docs(platform): record shared services scope and validation'
git -C "$TASK" rev-parse HEAD
git -C "$TASK" status --short
```

停在此分支供主控 CC 独立 review。任何发现先由 Codex 修复复审；不自动进入下一项，不推送/合并/发布。
