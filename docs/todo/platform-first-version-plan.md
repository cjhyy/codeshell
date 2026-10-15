# 平台首版实施与验收

基线：`233b446f79d9eaa05c5f9dba14efd3226e827fd0`；本批分支：`codex/host/platform-foundation-20261015`。
第 1 项 PR186、第 2 项 PR187 已合并；PR188 不作为本批前置。本文件跟踪首版剩余工作，不重做已完成 S0。

每批由 Codex 实现、验证、提交，再交主控安排 Claude Code 审查；Codex 修复并复审通过后才继续下一批。不得以计划、fixture 或接口声明代替生产接线和真实环境验收。

## S1 当前批：3–7（CC 首轮修复完成，待同一 CC 复审）

- [x] 3. 从 protocol/server.ts 抽请求分发和输入校验到 dispatch.ts，保持 v1 wire，降低架构行数预算；验收旧协议路由与非法输入。
- [x] 4. workspace bridge 改宿主显式安装开关；Desktop 保持启用，serve/Panel 无 bridge 使用磁盘回退；验收跨会话 send_message、resolve_session_run 的异步 AskUser 与邮箱唤醒实际路径。
- [x] 5. Panel agent-task 对 desktop/* 立即 -32601/unsupported；内部回环复用标准 unsupported answer，隐藏内部 ID，保留普通审批/已安装 Panel callback；无文字 UI 的 Panel AskUser 立即 unavailable；清 remote Link secret。
- [x] 6. 收齐第 16 章 9.2 本批 env/REPL/Windows PATH/内部回环防伪装遗留并写准确发版说明；验收所有 worker 启动 env、REPL runtime 和扩展注册入口。
- [x] 7. packages/host 1.1 最小生产骨架：仅依赖 core，能力注册/分发/adapter/生命周期；迁移 S0 纯逻辑，serve、Panel、Desktop 共用拦截，兼容已支持请求；接 workspace、构建、声明、打包导出 smoke 与 CI 发现。

出口：guarded unit shards、架构预算、engine-bypass、lint、完整 bun run typecheck、包发布/导出 smoke；逐路径提交，返回固定 base/head 与证据，停在本分支供主控 review。不推送、合并或发布。

## S1 后续批：8–14（待主控在 review 后派发）

- [ ] 8. 1.2 纯服务去重：skills、MCP 探测、模型探测、会话目录/transcript；依赖 1.1，目录隔离守卫随迁移。Desktop/serve 生产调用同一实现。
- [ ] 9. 1.3 凭据与 MCP OAuth 迁 host，由 adapter 注入 cipher；依赖 1.1。serve 同等能力，去掉 local 特例，验证凭据隔离。
- [ ] 10. 1.4 单 automation 执行器，共享锁/单 owner；依赖 1.1。同机两宿主只触发一次，serve automationCreate 可用。
- [ ] 11. Protocol v2：Schema 与客户端生成、版本协商、Session/Turn/Item、typed host/*、journal cursor 输出续传及 stateVersion 宿主状态续传、client/* 反向请求、TUI 真切换；保留 v1 兼容并覆盖断连、租约、非法 cursor。
- [ ] 8 的后续：输出回放去重，依赖第 11 项两类续传完成，把 Desktop snapshot 与 Hub seq/epoch 改为 journal cursor 缓存；验证不漏不重与快照回退。
- [ ] 12. PolicyEngine + ApprovalStore 真接工具、浏览器、process.native。
- [ ] 13. ExecutionService/report-only 技术验证。当前后端没有完整 dry-run：分别记录静态预检、单次执行观测、unknown，禁止双执行任意命令模拟 report-only。
- [ ] 14. 兼容矩阵、契约 CI 与发版验收：覆盖客户端/宿主/runtime/扩展版本组合、包边界、Schema 漂移、v1 降级、两类续传及权限契约。

S1 出口：Desktop/serve 共用会话、凭据、automation；TUI 在 v2 生产链路运行，策略接线与 report-only 验证有可复查证据。

## S2 多端批次（未实施）

- [ ] S2-A：1.6 拆 Desktop index 为领域注册模块，下调 index 预算至 1500；Desktop renderer 与 Web 真切 v2，手机编排 1.5 依赖两类续传和 client/*，验收旧 UI 行为及重连。
- [ ] S2-B：ExecutionService enforce，验证工具/浏览器/process.native 权限、取消与沙箱结果，不扩权降级。
- [ ] S2-C：保持在线与轻量常驻（连接时阻止睡眠、关窗口保留 HostRuntime）、薄云端票据中继/配对设备表/独立推送网关、Capacitor 首版。
- [ ] S2-D：手机派任务、审批、断网恢复、电脑 Panel 操作端到端验收；services/panel 跨仓业务与推送证书、签名 App、真机、Linux 目标分别列出代码 fixture 和真实环境验收，未具备真实条件不得标完成。

## S3 生态与沙箱批次（未实施）

- [ ] S3-A：统一扩展清单、签名与兼容审核；真实发布/安装与 fixture 分开验收。
- [ ] S3-B：Browser Panel runtime，迁移其余 HostService（pet/task-inbox/im-gateway/cc-room/external-runtime/operation batch）；按 capability 声明不可用项。
- [ ] S3-C：一任务一容器 runner，最少凭据、分支/PR、journal/附件上传、取消销毁与本地 fork；薄云端不承载常驻工作区。容器 fixture、Linux 目标与真实云资源验收分别记录。
- [ ] S3-D：评估 Desktop 本机守护进程（原生依赖打包、开机自启权限），不以评估替代默认内嵌宿主实现。

## 本批证据

初版代码提交：`c0cb47627950dce0a36e12dc85e631daced9a504`（协议分发）、`4afd746fe`（Host/worker 地基）。初次文档暂存曾被 Git 元数据权限拒绝；主控已在 `65dbd365b15f4935916765d7887939c6d1748a74` 补交六份文档并校正清单编号，该历史未提交状态已解决。第 8–14 项与 S2/S3 尚未实现；本轮只修复 CC 的三个 finding，完成后交同一 CC 复审。

| 清单 | 实际生产入口与行为 |
| --- | --- |
| 3 | `core/src/protocol/server.ts` 调用 `createProtocolDispatcher`；25 条内置路由、initialize/background RPC、扩展别名、Run/Goal 校验迁 `dispatch.ts`；server 预算 5174→4949，dispatch 独立预算 246。 |
| 4 | stdio 在加载项目设置前捕获 `CODE_SHELL_WORKSPACE_ACCESS=host`；Desktop AgentBridge 显式开启；serve/Panel 清除；TCP 保持无桥接的磁盘回退。真实 AgentServer/SessionManager/SendMessageToSession/NotificationQueue 路径验证跨会话、异步 AskUser 与邮箱唤醒，付费模型执行用 fixture 替代。 |
| 5 | `panels/agent-task-host.ts` 在 session 过滤前拦 desktop/*；内部回环回 approved:true + typed failure，普通审批/已安装 Panel callback 保留；Panel AskUser 立即 typed unavailable（无文字 UI），同步给明确原因、异步清 pending 不注入答案或唤醒；内部 resolved ID 不向客户端发出，客户端不能响应私有 ID。最终 env sanitize 包括自定义 builder。 |
| 6 | serve 两处 env、Desktop Web agent-task env 及 Panel 最终 worker env 清宿主开关/secret；REPL 写入协议/Bun executable/no-env-file；Windows env 归一；ToolRegistry catalog/late registration 与 composition 扩展入口禁止 __ 工具名；CHANGELOG 说明白名单边界。 |
| 7 | `packages/host` 仅依赖 core，HostRuntime 注册/分发/adapter 与同步生命周期；serve、Panel 和 Desktop adapter 调同一 interceptor，旧 host-requests 仅转导出；workspace、build 声明、release 清单、CI 发现已接入，Desktop 实际 bundle Host。 |

验证环境：Bun 1.3.11、Node 25.8.1。所有命令在本工作树执行；所有单测通过 guarded runner 使用隔离 HOME/应用状态并清凭据，不调用真实模型或付费服务。

- `bun run typecheck`：exit 0；包含完整根构建、14 个工作区及 Desktop main/preload/renderer/mobile 与 Web SPA。
- `bun run --cwd packages/desktop build:main`：exit 0；实际 Electron main bundle 成功。另用 esbuild 内存 fixture 确认 Host bundle 没有 server/web/coding input。
- `bun run lint`：exit 0，0 errors / 104 warnings；最后新增 Panel/Host/adapter 文件 targeted ESLint 亦 0 errors。
- `bun run lint:engine-bypass`：exit 0。
- `bun run lint:workflow-test-paths`：exit 0，20 个 workflow 字面量测试路径存在；Host 测试已进入 rest shard。
- 架构预算与包边界：包含在下方最终 guarded shard；`git diff --check` 通过。
- 最终单测：326 pass / 0 fail / 0 skipped，1193 assertions，34 文件。此前各组独立 shard 亦通过。Panel 新断言曾把随机 task-1… 误匹配成 ask-1，已改为匹配完整 JSON 字符串值并在最终 shard 通过。

历史受限项（主控已复验解决）及真实环境边界：

主控正常宿主 `bg_125xe7` 的严格 `&&` 链 `bun install --frozen-lockfile` → `bun run test:package-release` → guarded `serve-host-unsupported.test.ts` 已整体 exit 0，包含完整包 smoke 和 6 项 serve unsupported 测试，源工作树保持干净。下列 PermissionDenied/网络/监听失败保留为初次沙箱历史诊断，状态为 **resolved by controller verification**，不是当前尚未通过的验收。

- `bun install` 默认缓存不可写而报 tempdir PermissionDenied；改用可写 TMPDIR 与 BUN_INSTALL_CACHE_DIR 后，registry manifests 报 `ConnectionRefused` / `FailedToOpenSocket`。`bun install --frozen-lockfile --ignore-scripts --backend copyfile` 同样受网络限制。把固定 base 原始 manifests/lock 写到独立 ASCII `/private/tmp/codeshell-install-base-9gs154o3` 后，用 `--lockfile-only --frozen-lockfile --ignore-scripts` 仍可复现，故不是本批 Host lock 改动或中文模块路径错误。
- 依赖验证采用本机现有安装的 CoW 隔离副本；仅写本工作树，57 个 workspace symlink 重建为本工作树路径，审计无链接指向 main。全构建、严格声明与单测均在此隔离安装验证。以上为初次沙箱历史记录；主控后续已正常完成冻结安装，不能再视为未通过。
- `node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/serve/serve-host-unsupported.test.ts`：6 个用例在 `server.listen(0, 127.0.0.1)` 处失败，Bun 报 EADDRINUSE（errno 0），未进入 WS 路由。独立最小 Node listen probe 返回 EPERM（errno -1），Bun probe 返回相同 EADDRINUSE，确认沙箱禁止本机监听。没有改测试跳过断言或提升权限。
- `TMPDIR=/private/tmp/codeshell-platform-bun BUN_INSTALL_CACHE_DIR=/private/tmp/codeshell-platform-bun/cache-local bun run test:package-release`：10 包 clean build/pack/extract、48 个 strict NodeNext 声明入口及46个 runtime imports（含 Host）全部通过；strict published owner-auth consumer 编译通过；随后 `packed owner auth HTTP lifecycle (Node)` 在 listen 127.0.0.1 报 EPERM，exit 1。其后的 uploaded-document consumer 未执行。该 smoke 已结束后才运行完整 typecheck/Desktop build，未并发读被删除的 dist。
- 未执行原生 Windows、Linux、Electron UI 真机、签名 App、推送证书、跨仓 services/panel 或云容器真实验收；win32 为参数化契约覆盖，Desktop 为构建与 adapter fixture。REPL 仍非 OS 沙箱；Host 生命周期当前同步，大型异步服务留后续迁移。

初版 326 项 guarded shard 的完整命令（本轮不重跑无关套件；重复运行时仍须等待包 smoke 的 dist 重建完成）：


```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/core/src/protocol/server.dispatch.test.ts \
  packages/core/src/protocol/server.initialize.test.ts \
  packages/core/src/protocol/server.module-lifetime.test.ts \
  packages/core/src/protocol/server.image-only.test.ts \
  packages/core/src/protocol/server.goalcontrols.test.ts \
  packages/core/src/protocol/server.run-permission-boundary.test.ts \
  packages/core/src/protocol/server.steer.test.ts \
  packages/core/src/protocol/server.fork.test.ts \
  packages/core/src/protocol/server.plugin-commands.test.ts \
  packages/core/src/protocol/server.background-work-control.test.ts \
  tests/architecture-budgets.test.ts \
  packages/core/src/cli/stdio-host-config.test.ts \
  packages/core/src/protocol/server.workspace-bridge.test.ts \
  packages/core/src/protocol/server.session-message.host.test.ts \
  packages/core/src/protocol/server.session-message.lifecycle.test.ts \
  packages/core/src/protocol/server.askuser-async.test.ts \
  packages/core/src/protocol/server.bg-shell-wakeup.test.ts \
  packages/core/src/protocol/background-result-wakeup.test.ts \
  packages/core/src/protocol/session-message-workspace.test.ts \
  packages/core/src/tool-system/builtin/send-message-to-session.test.ts \
  packages/core/src/cli/__tests__/agent-server-stdio-credentials.test.ts \
  packages/core/src/runtime/spawn-common.test.ts \
  packages/core/src/tool-system/builtin/repl.test.ts \
  packages/core/src/tool-system/registry-defaults.test.ts \
  packages/core/src/composition/compiler.test.ts \
  packages/desktop/scripts/build-workspace-dependencies.test.ts \
  packages/desktop/src/main/worker-host-runtime.test.ts \
  packages/desktop/src/main/browser-driver/intercept.test.ts \
  tests/package-boundaries.test.ts \
  tests/publish-release-packages.test.ts \
  packages/host/src/runtime.test.ts \
  packages/server/src/panels/agent-task-host.test.ts \
  packages/server/src/panels/agent-task-execution.test.ts \
  packages/server/src/serve/host-requests.test.ts
```


## CC 首轮 review 修复（起点 65dbd365b，已复审通过）

CC 已只读复审 `65dbd365b..dfe75f6ef`，确认原 2 个 P1、1 个 P2 均关闭，未发现新增 P0/P1/P2。该结论仅覆盖代码审查；当前版本的完整包 smoke、unsigned pack 与 PR CI 仍是独立验收门槛。unsigned smoke 的 bundle 阶段会覆盖 predist main，因此其产物只用于依赖包装边界验证，不能视为与正式发布构建等价。

- P1-1：Host 改为 Desktop devDependency；`DESKTOP_MATERIALIZED_WORKSPACES` 真实驱动 predist 复制、生产依赖安装和导入校验，同一列表守卫 Desktop 及被实体化包的生产 workspace 闭包。静态测试阻止 Host 再进入生产依赖，unsigned pack 结果随后记录。
- P1-2：纠正初版“Panel AskUser 保留”的错误描述。Panel runtime 没有文字问答 UI，立即回 typed unavailable + unsupported 原因，不经 confirm、不泄露内部 ID/toolName。真实 runtime.taskScope→confirm→approvalRespond 验证普通审批批准/拒绝仍有效，已安装 Panel callback 仍经 tools.invoke/tool-results。真实 Core 验证 sync 不得到空答案/用户拒绝、async pending 退役且不注入答案/唤醒；正常 Desktop/Web 文字回答及用户明确拒绝保持原逻辑。
- P2-1：Desktop unsupported agent/approve 回复携带独立 UUID id；真实 AgentServer→adapter→AgentServer 验证 pending、timer、route 清理与 ACK。已知 desktop/* 无 id 帧继续由旧 authority 私下消费。
- Panel `CREDENTIAL_ACCESS=local` 的实际语义：使用 Core 本地凭据读取，不具备 Desktop IPC/safeStorage 服务；safeStorage 密文不可解时 fail-closed，既有 plaintext tag/legacy plaintext 读取行为保留，并非 task 独立凭据仓。

本轮代码提交：`2f5d094a9`（P1-1 打包依赖/生产 guard）、`c15fb5bab`（P1-2 Panel 问答与 Core 清理验证）、`16d72653d`（P2-1 RPC id/兼容通知）。起点 `65dbd365b15f4935916765d7887939c6d1748a74`，未开始 8–14。本轮没有改 Core 产品代码或抬高架构预算。

验证（所有单测均 guarded、隔离 HOME/凭据，无真实付费调用）：

- 最终定向 shard：113 pass / 0 fail / 0 skipped，704 assertions，10 文件；见下方完整命令。包含真实 Core pending 清理、Panel runtime 的生产确认入口、Desktop 回复回送 Core 和包装依赖守卫（含 semver、optional 错误生产依赖）。未重跑初版 326 项无关套件。
- Core→Host 先构建；必要 package smoke clean build 及 predist 又重建全部 Desktop workspace 依赖，均成功。之后 `bun run typecheck:workspaces` 14 个工作区全部 exit 0，包括 Desktop 与 Web SPA。没有与 package smoke/predist 并发读被重建的 dist。
- 修改文件 targeted ESLint exit 0；`bun run lint:engine-bypass` 与 `git diff --check` 通过；架构预算包含在最终 shard 中，未增长。
- `node --check packages/desktop/scripts/smoke-unsigned-pack.mjs` 与该脚本 `bundle` 模式成功。实际 build:main metafile 包含 Host runtime/host-requests/index，产物没有任何 Host external import。
- 上轮主控 `bg_125xe7` 的冻结安装、完整包 smoke、serve unsupported 测试成功状态保持 **resolved**。本轮依赖分组与 Host 新导出改动后的冻结安装/包 smoke 又在当前沙箱尝试：冻结安装在 registry manifests 报 ConnectionRefused/FailedToOpenSocket；包 smoke 的 10 包 clean build/pack/extract、48 个 strict NodeNext 声明入口、46 个 runtime imports 与 owner-auth consumer 编译均成功，随后 HTTP listen 报 EPERM，后续 uploaded-document consumer 未执行。记录在 `/private/tmp/codeshell-review-install.log`、`/private/tmp/codeshell-review-package-release.log`；这是本轮新状态的受限复验，不把上轮主控成功说成未成功。
- 实际 unsigned predist/pack 已尝试，未签名、notarize 或发布：predist 完成全部 workspace 构建，进入 Desktop build 后下载 `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.1/cua-driver-rs-0.34.1-darwin-universal-binary.tar.gz` 报 ConnectionRefused，未进入 workspace 实体化。随后独立 pack 已复制本地 Electron，但因上述前置失败而遇到 `packages/coding/THIRD_PARTY_NOTICES.md must be under packages/desktop/`。不能据此声称完整 unsigned pack 已通过；没有伪造 native 产物或把依赖越界断言绕过。

可在正常宿主从本工作树严格补跑：

```sh
bun install --frozen-lockfile &&
bun run test:package-release &&
node packages/desktop/scripts/smoke-unsigned-pack.mjs predist &&
node packages/desktop/scripts/smoke-unsigned-pack.mjs bundle &&
node packages/desktop/scripts/smoke-unsigned-pack.mjs pack
```

仓库内 smoke 脚本以自身位置定位本工作树，所有子进程显式 cwd，创建隔离 HOME/应用状态并清凭据；pack 使用原生产配置和真实生产依赖图，明确关闭 afterPack/afterSign、mac sign/identity/notarize、publish 和 native rebuild，使用本地 Electron 执行 `--dir --publish never`。它验证 unsigned 包装边界，不替代正式签名、native/UI/真机验收。

最终定向 shard：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/host/src/ask-user-unavailable.test.ts \
  packages/host/src/runtime.test.ts \
  packages/server/src/panels/agent-task-host.test.ts \
  packages/server/src/panels/runtime-agent-task.test.ts \
  packages/core/src/protocol/server.askuser-async.test.ts \
  packages/core/src/protocol/server.askuser-session-isolation.test.ts \
  packages/desktop/src/main/worker-host-runtime.test.ts \
  packages/desktop/scripts/build-workspace-dependencies.test.ts \
  tests/architecture-budgets.test.ts \
  tests/package-boundaries.test.ts
```

原生 Windows/Linux/签名 App/真机等真实环境仍未验。CC 非阻断的模型直接调用 `__*` 防护属既有独立项，保留清单，不在本轮扩大到 v2/PolicyEngine/executor 重写。


本轮最后暂存文档再次受 Git 元数据权限限制：创建本树对应的共享 `index.lock` 报 `Operation not permitted`。三笔修复代码提交已完成；`CHANGELOG.md`、`TODO.md`、`docs/architecture/16-platform-consolidation.md`、本计划、`packages/host/README.md` 五份文档由主控在复审前使用正常宿主 Git 补交。不提升权限、不改 main，也不绕过 Git 元数据限制。该本轮状态与上轮已补交的 `65dbd365b` 文档记录分开。
