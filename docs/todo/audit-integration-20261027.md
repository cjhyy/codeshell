# 四批审计组合候选：2026-10-27

当前状态（2026-10-27）：原 CC session `3e34f601-e67b-4de4-a43f-eba9cf0283f3`
最终独立组合验收 PASS：Host 111 files、1628/0/0，Panel 完整 check 52/0/0、三 ZIP equal，
无 Critical / Important。主代理已 resume；两仓受审候选已快进合入各 root 的本地 main。
随后仅在任务分支补交付文档再快进 main，受审源码不变；未 push、发布或执行原生验收。

## 基线与候选

| 仓库  | 组合前本地主线                             | 任务分支 / 候选                                                                                   |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Host  | `2035c0a30f51c37415814b340c364fee490e667f` | `codex/core/audit-integration-20261027`，受测代码候选 `2d031febea54a138d7e14de4a778da3f38dcde26`  |
| Panel | `d15a35bec1910c0a55be7b737a5343314635d4a2` | `codex/panel-shared/release-zip-integration-20261027`，`c6dbba4272a7e15de58c46a0624e774c17264aed` |

候选冻结阶段按指定边界未 fetch；本轮 resume 已对两仓执行 `git fetch --no-tags origin`，
origin/main 仍分别为 `2661eb04da4266c532464bc8bd9223aeba0d9caa` /
`84348855be8ae4e5a31936b3c2b0d1d21410bd64`。合并前核对两个 root 均 clean、main 仍为指定基线，
且 origin/main 是各基线祖先。基线各含 18 / 5 个远端尚无的本地提交，包含其他独立任务；
全部保留，不搭车 push。

## 来源、原验收与转入方法

| 批次        | 来源 worktree（各自仍未提交）                                 | 原基线      | 交付路径数               | 原 CC 历史 PASS              |
| ----------- | ------------------------------------------------------------- | ----------- | ------------------------ | ---------------------------- |
| A NSIS      | `codeshell/.worktrees/nsis-uninstall-holder-20261026`         | `55dce4044` | 7（5 tracked + 2 new）   | 二轮 196/0                   |
| B Mobile    | `codeshell/.worktrees/mobile-legacy-base-pages-20261026`      | `55dce4044` | 20（17 tracked + 3 new） | 361/0                        |
| C probe/WER | `codeshell/.worktrees/windows-launch-diagnostics-20261026`    | `55dce4044` | 7（4 tracked + 3 new）   | 161/0                        |
| D runbook   | `codeshell/.worktrees/audit-remaining-runbooks-20261026`      | `2035c0a30` | 2（1 tracked + 1 new）   | 主仓仅文档                   |
| D ZIP       | `codeshell-panel-apps/.worktrees/verify-release-zip-20261026` | `8434885`   | 6（2 tracked + 4 new）   | 二轮 52/0，完整 check exit 0 |

逐源检查 status、tracked binary diff、所有 untracked 交付路径与内容，未发现陌生变化。
tracked diff 保存为审阅 patch，经 `git apply --check` 后顺序应用；新文件按明确清单逐个
读取/复制，没有复制来源目录、node_modules 或 artifacts。Panel 依赖另按下述独立克隆。
来源 manifest、patch、SHA-256 与原 status 保存在目标 ignored
`.code-shell/reviews/audit-integration-20261027/`。收尾再次对所有来源 status 与每个交付文件
摘要校验，来源全部保持原样；不在来源提交、删除或清理。

唯一 patch 上下文冲突是 B 的 TODO hunk：main 已新增两个 memory/执行观测条目，
旧上下文无法套用。对 B 其余 tracked patch 正常应用，只精确替换原 Mobile 一行，再应用
D 的 TODO 增量，保留 main 两条新内容及四批状态。没有实质代码冲突或额外代码修改。
`index.ts` 仅加 `legacyBasePages: true`；移除此行即与 main2035 文件逐字节相同。
A/C 12 个代码/测试/PS1、B 其余 17 个代码/测试、Panel 工具/测试/suite 均等于来源字节。

main 的 `55dce4044..2035c0a30` 46 条变化中，44 个非重叠路径完整保留；四个 memory /
模型身份 / Claude inference / auth-resolution 提交 `d93a3ab9e`、`211664da9`、`90d0cb025`、
`3fa08b650` 保留祖先关系。A 的完整 runner、normal assertion、卸载 absent catch、
final-integrity→EOF 与 H11 整文件均与旧基线、main 三方逐字节一致。
WMI→句柄的单向微秒 helper、原句柄 100ns 身份及全部原生未验边界原样保留。

交付文档仅更新当前组合指向、来源历史 PASS 和精确 probe/collector usage；保留原
BLOCKED→C1、软链假差异→独立依赖修复与各次红绿日志，不外推为已发布或真机验收。

## 隔离、失败调查与最终串行回归

Host 按根指导 `bun install --frozen-lockfile` exit 0（2099 packages），依赖和缓存独立在
本目标；锁文件无 diff。Node 25.8.1、Bun 1.3.11。每个命令先以现有
`createBunTestEnvironment` 白名单清凭据，HOME/XDG/Host state 独立；单测再经官方 guarded
Bun/Node runner。最终 TMP 使用仓库外的新私有临时目录，子进程 close 后清理；不触真实 HOME。
Panel 使用独立 `/bin/cp -cR` node_modules（普通目录、不同 inode），无依赖软链或可写 dist
链接；使用私有 HOME/XDG/TMP、凭据白名单、npm offline。

首次组合 build、Core107/0、消费者328/0 后，dispatch 为24/2。原因是本轮将 TMP 放在
Git 仓内，ProjectStore 的 `git rev-parse --show-toplevel` 将临时项目折叠为仓根，真实身份
门禁正确拒绝。没有放宽产品校验或测试。为复现，在目标内保存组合文件摘要并临时还原
tracked 包文件至 `2035c0a30`，baseline build exit 0，原 TMP 的 baseline dispatch 同为
24/2（两项相同错误）；随后组合文件全部逐字节恢复。将 TMP 改为仓外私有目录后，从
build 开始重跑最终全部选择；失败和基线日志保留，不将它们计入最终通过数。

测试按文件去重：Core5 + Mobile16 + dispatch3 为24文件；与新 main 的60文件清单
重叠4，增加56个 runtime-memory/模型身份/Claude inference/trace/tools/credentials 邻居，
共80个 Bun 源码文件。原 Node18扩为22，覆盖 A 全部11文件、C 全部6个 Node文件与新 dump
测试；packaged Bun9包含 C 的2文件。Host 最终共111个 distinct test files，不能相加
四批历史 PASS，也不重复统计共享测试。

| 最终分组                                          | 文件 | pass / fail / skip | 日志                                |
| ------------------------------------------------- | ---- | ------------------ | ----------------------------------- |
| Core journal                                      | 5    | 107 / 0 / 0        | `final-core.log`                    |
| Mobile / Desktop / Hub / Web 消费者               | 16   | 328 / 0 / 0        | `final-mobile-consumers.log`        |
| Mobile dispatch                                   | 3    | 26 / 0 / 0         | `final-mobile-dispatch.log`         |
| main runtime / memory / identity / inference 邻居 | 56   | 740 / 0 / 0        | `final-runtime-memory-adjacent.log` |
| Windows / NSIS / probe / dump Node 合同           | 22   | 364 / 0 / 0        | `final-windows-node.log`            |
| packaged Bun 合同                                 | 9    | 63 / 0 / 0         | `final-packaged-bun.log`            |

Host 合计 **111 个文件、1628 pass / 0 fail / 0 skipped**。以下门禁全部 exit 0：

| 门禁                             | 结果                      | 日志                        |
| -------------------------------- | ------------------------- | --------------------------- |
| bun run build                    | 完整 root build           | `final-build.log`           |
| bun run typecheck                | 完整 build + 14 workspace | `final-typecheck.log`       |
| bun run lint                     | 0 errors / 99 warnings    | `final-lint.log`            |
| engine-bypass                    | 通过                      | `final-engine-bypass.log`   |
| workflow paths                   | 97 literal paths 全存在   | `final-workflow-paths.log`  |
| 29 个 TS/TSX/MJS 源文件 Prettier | 通过                      | `final-prettier-source.log` |
| dump collector --help            | 通过，仅 usage            | `final-dump-help.log`       |
| git diff --check                 | 通过                      | `final-diff-check.log`      |

完整命令按下列顺序执行；所有最终日志均在本目标
`.code-shell/reviews/audit-integration-20261027/final-<分组>.log`，原始 argv/UTC/退出码在
`results.jsonl`，精确选择清单在 `test-plan.json` / `final-validation-plan.json`。
未运行 package-release cleanbuild；任何 dist 读写检查均顺序完成。

```sh
bun install --frozen-lockfile
bun run build
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/core/src/session/output-journal.test.ts ./packages/core/src/session/output-journal-identity-migration.test.ts ./packages/core/src/session/output-journal-persistent-identity.test.ts ./packages/core/src/session/output-journal-storage.test.ts ./packages/core/src/session/output-journal-legacy-base.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/main/mobile-remote/output-recovery.test.ts packages/server/src/mobile-remote/mobile-client-event-validator.test.ts packages/web/src/hooks/mobileOutputClient.test.ts packages/web/src/hooks/useRemoteApp.test.tsx packages/web/src/lib/mobileOutputRecovery.test.ts packages/web/src/lib/outputJournalRecovery.test.ts packages/web/src/lib/transcriptReplay.test.ts packages/desktop/src/main/session-transcript-ipc.test.ts packages/desktop/src/main/output-journal-recovery.test.ts packages/server/src/serve/headless-server.test.ts packages/web/app/chat.test.ts packages/server/src/mobile-remote/remote-host-manager.test.ts packages/desktop/src/main/mobile-remote/handle-client-event.test.ts packages/core/src/protocol/mobile-remote-types.test.ts packages/desktop/src/main/external-runtime-state.test.ts packages/desktop/src/renderer/app/useTranscriptBuckets.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/main/mobile-remote/external-runtime-commands.test.ts packages/desktop/src/main/mobile-remote-orchestrator.test.ts packages/desktop/src/main/mobile-remote-controller.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/coding/src/external-runtimes/claude-code/event-translator.test.ts packages/coding/src/external-runtimes/claude-code/mcp-config.test.ts packages/coding/src/external-runtimes/claude-code/permissions.test.ts packages/coding/src/external-runtimes/claude-code/runtime.test.ts packages/coding/src/external-runtimes/claude-code/text-inference.test.ts packages/coding/src/external-runtimes/codex/app-server-client.test.ts packages/coding/src/external-runtimes/codex/event-translator.test.ts packages/coding/src/external-runtimes/codex/model-discovery.test.ts packages/coding/src/external-runtimes/codex/runtime.test.ts packages/coding/src/external-runtimes/session-factory.host-tools.test.ts packages/coding/src/external-runtimes/session-factory.test.ts packages/coding/src/external-runtimes/session-factory.tool-parity.test.ts packages/coding/src/external-runtimes/shared/mcp-bridge.test.ts packages/coding/src/external-runtimes/shared/session-context-store.test.ts packages/coding/src/external-runtimes/shared/spawn-env.test.ts packages/core/src/credentials/cookie-domain.test.ts packages/core/src/engine/auxiliary-pipeline.memory-output.test.ts packages/core/src/engine/auxiliary-pipeline.test.ts packages/core/src/engine/engine.quick-chat-ephemeral-memory.test.ts packages/core/src/index.exports.test.ts packages/core/src/model-traces/capture.test.ts packages/core/src/model-traces/classification.test.ts packages/core/src/model-traces/native-frames.test.ts packages/core/src/model-traces/native-process.test.ts packages/core/src/model-traces/sanitize.test.ts packages/core/src/model-traces/sessions.test.ts packages/core/src/model-traces/store.test.ts packages/core/src/model-traces/stream-cancel.test.ts packages/core/src/model-traces/tool-events.test.ts packages/core/src/services/extract-memories.test.ts packages/core/src/services/memory-orchestrator.canonical.test.ts packages/core/src/services/memory-orchestrator.custody.test.ts packages/core/src/services/memory-orchestrator.test.ts packages/core/src/services/memory-orchestrator.write-context.test.ts packages/core/src/services/memory-transcript.test.ts packages/core/src/services/session-memory-sort.test.ts packages/core/src/services/session-memory.custom-root.test.ts packages/core/src/services/session-memory.home-isolation.test.ts packages/core/src/tool-system/builtin/bash-output-style.test.ts packages/core/src/tool-system/builtin/bash.exit-diagnostics.test.ts packages/core/src/tool-system/builtin/bash.shell-env.test.ts packages/core/src/tool-system/builtin/grep.test.ts packages/core/src/tool-system/registry-result-protocol.test.ts packages/core/src/tool-system/session-tool-host.configured-hooks.test.ts packages/core/src/tool-system/session-tool-host.mcp-caller.test.ts packages/core/src/tool-system/session-tool-host.options-contract.test.ts packages/core/src/tool-system/session-tool-host.path-access.test.ts packages/core/src/tool-system/session-tool-host.run-context.test.ts packages/core/src/tool-system/session-tool-host.settings-parity.test.ts packages/core/src/tool-system/session-tool-host.test.ts packages/core/src/tool-system/session-tool-host.vision.test.ts packages/desktop/src/main/external-runtime-memory.test.ts packages/desktop/src/main/external-runtime-service.operations.test.ts packages/desktop/src/main/external-runtime-service.test.ts packages/desktop/src/main/external-runtime-tracing.test.ts tests/abort-subprocess.test.ts
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/electron-test-watchdog.test.mjs packages/desktop/scripts/electron-test-process-snapshot.test.mjs packages/desktop/scripts/windows-source-harness.test.mjs packages/desktop/scripts/electron-harness.test.mjs packages/desktop/scripts/nsis-initial-identity-observation.test.mjs packages/desktop/scripts/smoke-windows-nsis-install.test.mjs packages/desktop/scripts/windows-nsis-acceptance.test.mjs packages/desktop/scripts/e2e-startup-operation-cycles.test.mjs packages/desktop/scripts/process-custody.test.mjs packages/desktop/scripts/windows-nsis-crash-evidence.test.mjs packages/desktop/scripts/windows-nsis-process-roles.test.mjs packages/desktop/scripts/panel-operation-diagnostics.test.mjs packages/desktop/scripts/macos-dmg-custody.test.mjs packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs packages/desktop/scripts/composer-operation-diagnostics.test.mjs packages/desktop/scripts/packaged-startup-observation.test.mjs packages/desktop/scripts/packaged-signal-diagnostics.test.mjs packages/desktop/scripts/packaged-appimage-runtime.test.mjs packages/desktop/scripts/windows-nsis-checkpoint-diagnostics.test.mjs packages/desktop/scripts/windows-nsis-desktop-observation.test.mjs packages/desktop/scripts/nsis-safe-per-user-install-mode.test.mjs packages/desktop/scripts/windows-wer-dump-evidence.test.mjs
node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/desktop/scripts/packaged-pet-shutdown.test.mjs ./packages/desktop/scripts/packaged-main-preload.test.mjs ./packages/desktop/scripts/packaged-chromium-guard.test.mjs ./packages/desktop/scripts/packaged-app-layout.test.mjs ./packages/desktop/scripts/packaged-linux-environment.test.mjs ./packages/desktop/scripts/packaged-process-exits.test.mjs ./packages/desktop/scripts/packaged-pet-bootstrap.test.mjs ./packages/desktop/scripts/packaged-app-integrity.test.mjs ./packages/desktop/scripts/run-packaged-ui-acceptance.test.mjs
node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/windows-wer-dump-evidence.mjs --help
bun run typecheck
bun run lint
bun run lint:engine-bypass
bun run lint:workflow-test-paths
```

源格式使用本地 Prettier，对来源清单中全部 TS/TSX/MJS 明确路径执行 `--check`；PS1 不在
Prettier 支持范围。另检查 C 交接与本记录格式、`git diff --check`、workflow path guard。
没有修改 workflow、Secrets、账号、生产、真实 WER/LocalDumps 或已安装应用；没有真实
provider/付费调用、Windows/pwsh 执行、CI 触发、工件/dump 上传、Release 或远程验收。

## Panel 组合证据与未完成项

Panel `npm run check -- --suite release-zip` 完整前置同步、类型与确定性包检查 exit 0，
52 pass / 0 fail / 0 skipped。`git diff --exit-code d15a35b -- apps panels templates`
为空；未更新 Video 生成包。三个来源已有真实 ZIP 由新候选只读复核：Download34、Video41、
Design145文件，全部 equal / 0 differences，ZIP SHA-256 与来源一致，没有下载或复制 ZIP。
精确 tag/commit、摘要、命令与日志见 Panel
`docs/acceptance/panel-release-zip-20261026.{md,evidence.json}` 的组合补记；本轮日志在该目标
ignored `artifacts/release-zip-integration-20261027/`。旧8434885目录比较保留为历史测量。

仍未完成：Windows 真实 retained-handle /
NSIS16阶段、M1/M2、首窗真包与真实dump/符号根因，实体手机/弱网/真包冷重启，签名/公证/
跨版升级回滚，六Panel版本freeze/正式安装，runbook中的真实账号、owner迁移、薄云端恢复与
业务决策。最终组合 review 和本地合并已经完成，不关闭上述真实环境或决策项。
来源工作树与原始证据完整保留，不为清理丢失未提交内容；本轮不 push、不发布。

## 候选冻结阶段任务提交收尾

Host 受测代码候选：`2d031febea54a138d7e14de4a778da3f38dcde26`；Panel 候选：
`c6dbba4272a7e15de58c46a0624e774c17264aed`。本次随后仅补本文件回执，受测代码不变。
两仓只按明确任务路径 staging，未 stage artifacts、依赖、生成包或 workflow；来源均未提交。
候选冻结时两个本地 main 与 origin/main refs 保持本记录基线，两候选工作树 clean。

| 原 CC 受审候选相对指定本地主线的 stat | 文件 | 新增 / 删除 |
| ------------------------------------- | ---- | ----------- |
| Host（包含本回执）                    | 36   | 6120 / 94   |
| Panel                                 | 6    | 3763 / 0    |

## 最终 CC PASS 与本地合并交付回执

2026-10-27，主代理转交原 CC 最终独立验收 PASS：Host 111 文件、1628 pass / 0 fail /
0 skipped；Panel `npm run check -- --suite release-zip` 为52/0/0，三真实 ZIP equal。
原 CC 逐字节确认所有来源代码无漏修，`index.ts` 只新增 `legacyBasePages: true` 并保留
main memory，未发现 Critical / Important。build、typecheck、lint 使用上文已通过日志。

刷新 origin 并重新核对两个 root 干净、仍在 main、HEAD 未偏离指定基线后，已实际执行：

- Host root `/Users/admin/Documents/个人学习/代码学习/codeshell`：
  `git merge --ff-only 78ffd848a02536e5aafe9ee9997c4d5e10d3ee17`，由 `2035c0a30` 快进成功。
- Panel root `/Users/admin/Documents/个人学习/代码学习/codeshell-panel-apps`：
  `git merge --ff-only c6dbba4272a7e15de58c46a0624e774c17264aed`，由 `d15a35b` 快进成功。

两次受审候选合入后 root 均 clean。此后仅在各任务分支提交交付文档，再对 root main
执行 `--ff-only`；最终文档提交与 main SHA 由外部交付报告列出，不自引用本文件提交。
所有非文档路径与原 CC 候选逐字节相同，只做文档/diff/链接验证，不重复全套单测。
未推送任何分支，未改 workflow、账号/Secrets、生产、真实 HOME、已安装应用或发布状态。

未做 worktree/分支清理：两个 integration worktree 仍有本轮/外部 agent 的 cwd 使用且保留
组合日志，交主代理退出后处理。以下五个来源保持原始 dirty、未提交；42项交付 bytes、
完整 status 与 binary patch SHA 均未变化，无陌生改动。没有把它们 checkpoint、重置或删除：

- `/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/nsis-uninstall-holder-20261026`
- `/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/mobile-legacy-base-pages-20261026`
- `/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/windows-launch-diagnostics-20261026`
- `/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/audit-remaining-runbooks-20261026`
- `/Users/admin/Documents/个人学习/代码学习/codeshell-panel-apps/.worktrees/verify-release-zip-20261026`

Panel 来源保留三个真实 ZIP、原始核对 JSON、I1 成功与旧失败日志；Host/Panel 目标保留
组合日志与 manifest。尚未完成全部进程 cwd 释放和必要 ignored 证据独立归档核验，因此
不尝试将 dirty 来源变 clean 后移除。未触碰其他 worktree，尤其未触碰 `~/.codex` 下任务。
