# Round 4：Core settings / personalization / schema / migration

冻结基线 `4ee32f28f78b8315112cca77cfc22b2f2f80ced6`，分支 `codex/audit/context-round4-20261017`。本专项只新增本报告及 `evidence/settings-*`，未改产品、既有测试或依赖，未执行 Git 分支、索引或提交操作。已读 CODESHELL.md；按上级冻结快照要求沿用既有专项 worktree，不 fetch / 切换 / 建分支。

本专项确认 **2 项：1 P2 + 1 P3**。新增执行 **2 个文件、9 个测试、46 个 expect、0 fail / skip**；两份首次原始 stdout+stderr 日志均有 guarded Completed，退出码均为 0。测试断言明确记录当前错误行为，不是修复后回归测试。没有首轮支架、依赖或平台失败，没有重试、修复支架或换方法。

## SET-01 / P2：user 单字段保存遮蔽 YAML 中所有未写入的配置

根因在 [manager.ts:550](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/manager.ts:550)：`saveUserSetting` 用 `readConfigFileForMutation(settings.json) ?? {}` 作为整文件写入基底，未经过 YAML-aware 的 `readJsonObjectForMutation`。当用户层只有合法 `settings.yaml` / `settings.yml` 时，它从空对象写出新 `settings.json`。而 [loader:924](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/manager.ts:924) 和 [resolveConfigPath:1086](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/manager.ts:1086) 明确让 JSON 优先于 YAML，所以新文件遮蔽原有整个用户层。

正常入口可达链为 TUI [/config set:797](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/cli/commands/builtin/core-commands.ts:797) → protocol [`config_set`:3498](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/protocol/server.ts:3498) → Engine [`updateConfig`:4679](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/engine.ts:4679) → `saveUserSetting`。本轮动态运行真实 SettingsManager，入口接线为源码核验；未启动真实 TUI、协议 transport 或 Engine。

复现从自有临时 userConfigDir 中的合法 YAML 开始：`agent.responseLanguage: zh`、`agent.userProfile: Owned audit profile`、`images.detail: high`。首次加载值正确；仅保存 `agent.responseLanguage=en` 后，新 JSON 实际内容为 `{ "agent": { "responseLanguage": "en" } }`。新建 manager 加载只剩新语言，`userProfile` 和 `images` 均消失。`.yaml` 和 `.yml` 两例相同。

影响是一次成功的正常偏好写入使其他用户层设置不再生效；落盘后新建 manager 重新加载仍出现，真实 app 重启未执行。**原 YAML 字节没有被删除**，移除本次生成的 JSON 后原值恢复；不把遮蔽描述为原文件物理丢失，也不声称本轮测试了真实凭据、模型配置或其他全部字段。修复应在同一锁内按 loader 相同优先级读取完整 user 层，再修改和写出 JSON。project writer 已采用这条路径；JSON 用户层、YAML project 层和 user 原子 mutation 三个正常控制均保留无关字段。

证据：[fixture](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-yaml-write.test.ts)、[首次原始日志](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-yaml-write.first.log)、[退出码](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-yaml-write.first.exit.txt)：**5 pass / 31 expect / 0 fail、skip / exit 0 / Completed**。

## SET-02 / P3：Config 成功写入 schema 不接受的值，下一次设置读取失败

真实 [Config:99](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/tool-system/builtin/config.ts:99) 只用 `setDottedSetting` 检查 key 路径，随后 [143](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/tool-system/builtin/config.ts:143) 调用 `saveProjectSetting`。该 writer [manager.ts:581](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/manager.ts:581) 修改对象后直接持久化，没有校验修改后的 settings shape；`saveUserSetting` 的 [552–558](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/manager.ts:552) 同样如此。与之相对，原子多字段 writer 在 [639](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/manager.ts:639) 明确执行 `validateSettings(merge({}, current))` 后才写入。

复现运行真实 `configTool`，提供自有 cwd 的正常工作区路径，未替换 writer 或路径审批结果。初始合法 `agent.responseLanguage: "zh"` 可读；写入 `{action:"write", key:"agent.responseLanguage", value:true}` 返回 **`Updated agent.responseLanguage = true`**，磁盘确实持久化 boolean，其他 profile 字段仍在。但 [schema.ts:100](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/schema.ts:100) 规定该字段只能是 string，真实 schema 拒绝该对象，新 SettingsManager `get()` 抛错。user 单字段 writer 对同一输入也接受并导致下一次加载抛错，合并为同一根因，未另计编号。

级别限定 P3：需要调用方提供已知字段的错误类型；结果是落盘后 settings 读取失败和误报更新成功。本轮未运行实际 app 启动，不声称 Electron 崩溃、所有会话不能运行或合法偏好值会触发。再次用 Config 写回合法 string 可恢复，因此也不声称不可恢复数据损坏。应在锁内校验拟写入的层（保留合法 tombstone 与未知扩展字段语义），拒绝无效值并保留原文件。控制中 `mutateSettingsForScope` 对同一非法值拒写且磁盘字节不变，同时仍能保存未知 `auditExtension` 对象。

证据：[fixture](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-invalid-write.test.ts)、[首次原始日志](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-invalid-write.first.log)、[退出码](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-invalid-write.first.exit.txt)：**4 pass / 15 expect / 0 fail、skip / exit 0 / Completed**。

## 单列候选与排除，不计发现或新增执行

- **C-SET-01（仅静态）**：`migrateModels` 在任一 model 缺少 providerKey 时重新计算所有 model 的 providerKey，忽略已有合法引用（[migrate-models.ts:158](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/migrate-models.ts:158)、[184](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/migrate-models.ts:184)）。混合“只含 providerKey 的已迁移条目”与一个旧条目可能改写已有关联；现有测试接受前一种格式。但当前 [Engine:903](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/engine.ts:903) 已只从 modelConnections 注册选择，没有证据证明此候选会让当前正常模型请求走错 endpoint。provider_delete 和 Desktop model-meta 仍读 legacy 关联，但本轮未动态验证具体产品影响，所以不登记确认项，不运行真实模型或 metadata 网络取数。
- **C-SET-02（仅静态）**：通用 `migrateConfig` 在自定义 migration 列表有 gap 或输入来自未来版本时仍写 target stamp（[migrate-config.ts:130](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/migrate-config.ts:130)、[138](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/migrate-config.ts:138)）。生产 registry 当前是连续 0→1→2，manager 又不持久化仅 stamp 的差异；没有当前生产数据行为的可达失败证据，不列 bug。
- personalizationFrom 是三字段直接映射；当前 schema、diskDefaultsFrom 和 PromptComposer 对语言/profile 的接线已读，没有独立的新问题。Desktop 初始加载覆盖编辑和自动保存失败恢复已有旧报告，不重复登记。TUI `/config show|get` 的 scope 差异由 root 独立审查，不纳入本专项。

## 去重、覆盖与隔离

[去重记录](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-dedup.json) 扫描前三份 audit 与顶层 `docs/review*` 下 **619 个 Markdown/JSON 文件**；SET-01 / SET-02 的针对性行为/路径检索均无匹配。另实际阅读 `settings-recovery-round16.md`，并检索 Desktop/web/remote 既有设置报告。旧 R70 是 Desktop 拒写后清掉 debounce 队列；本轮 SET-01 是成功 user writer 遮蔽 YAML，SET-02 是成功 writer 持久化 schema 非法值，根因与恢复契约不同。静态迁移候选的 32 个检索匹配主要是既有依赖清单引用，不作为发现数。

静态覆盖：settings manager、schema、personalization、migrate-config、schema-export、feature-flags、recovery 的文件内容；migrate-models 的完整纯转换；Engine update/read/config-population 与 disk defaults、PromptComposer personalization、protocol config_set 与 legacy model handlers、TUI config caller；ModelPool / ProviderCatalog 和 Desktop model-meta 的相关段。既有 tests 仅选择性阅读，没有运行整个 settings、Core 或仓库测试套件。[源码 SHA-256 清单](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-source-manifest.json) 记录 17 个文件，不能将清单理解为每个大文件都逐行审阅。

两份 fixture 都通过规定命令首次执行：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round4/evidence/settings-yaml-write.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round4/evidence/settings-invalid-write.test.ts
```

runner 建立独立真实 HOME 并移除继承凭据；fixture 检查 runner marker，在动态导入 Core 之前拒绝 fetch/http/https/net/tls 连接。所有写入位于 fixture 自己的临时 cwd / userConfigDir，afterEach 删除；没有真实用户数据、模型调用、付费 API、外部服务、插件安装、hook 执行、shell 子实验或认证/安全实验。连接 guards 仅覆盖所测进程 API，不声称 OS 网络沙箱。真实 Native/Electron/TUI transport、跨进程并发、存储故障、所有 YAML 特性、完整 migration combinations 未执行。测试成功只支持上列具体行为与控制。

[汇总收据](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round4/evidence/settings-receipts.json) 单列两个首次运行、计数与哈希；本专项完成，不进行产品修复。
