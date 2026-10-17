# Round 15：legacy settings migration / plugin source metadata

冻结基线 `ae777b3fce6fc9986e69ceb62802f3bb3f6aa478`。本专项 **0 项新增确认 bug、1 个新候选、1 个旧候选关联**。两组首次 guarded 测试共 **11 pass / 27 expect / 0 fail / 0 skip**，均有 `Completed Bun shard` 与退出码 0。未修改产品代码、既有测试、依赖或 Git 分支/索引/提交；只写本报告和 `evidence/migration-*`。

## MIG-R15-C1：`.git` 来源边界的纯解析观察，未提升为 bug

真实 `parseSource` 的两个观察共列一个来源规范化候选：

| 自有输入字符串 | 实际纯函数结果 | 正常控制 |
| --- | --- | --- |
| `https://example.invalid/owned/notes.git/` | `url` 原样保留；`inferredName: "notes.git"` | 去掉尾斜杠后 `inferredName: "notes"` |
| `github:owned/notes.git` | `url: "https://github.com/owned/notes.git.git"`；`inferredName: "notes.git"` | `github:owned/notes` 得到一个 `.git` 后缀和 `inferredName: "notes"` |

第一条来自 [parseSource.ts:123](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/plugins/installer/parseSource.ts:123)：先在整串 URL 末尾去 `.git`，再过滤空 path 段；尾斜杠使去后缀步骤不匹配。第二条来自 [parseSource.ts:182](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/plugins/installer/parseSource.ts:182) 调用 [gitOps.ts:206](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/plugins/gitOps.ts:206)，后者无条件附加 `.git`。这两个具体返回值已由真实纯函数首次执行证明，**没有执行 Git、clone、插件安装或远程存在性验证**。

当前 [CLI:29](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/cli/commands/plugin.ts:29) 把用户提供的 source 交给此 parser，[33](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/cli/commands/plugin.ts:33) 在没有 `--name` 时选择 `inferredName`，接线仅静态核验。现有[设计规则](../superpowers/specs/2026-05-29-plugin-remote-install-design.md)与测试示例明确给出 `github:org/repo`、普通 HTTPS `.git` 和 SCP-style SSH，但未明确承诺两个边界形态必须被支持，也未找到当前正常应用生产器自动产生它们的证据。因此本轮不给严重性，不声称真实安装失败、安装目录名必然错误、账号或网络故障。若后续确定支持这些边界形式，应分别在提取末段后去 `.git`、以及 GitHub shorthand 转换处避免重复附加后缀。

证据：[纯解析 fixture](evidence/migration-source-pure.test.ts)、[首次原始日志](evidence/migration-source-pure.first.log)、[首次退出收据](evidence/migration-source-pure.first.exit.json)：**7 pass / 11 expect / exit 0 / Completed**。另外五项正常控制覆盖本地相对路径和空格路径、GitHub ref/subdir/raw、npm scoped exact-version 规范化、dist-tag/default latest、SCP-style SSH 元数据。测试以 `.invalid` 和自有 inert 名称为字符串，不读取任何账号或执行来源。

## 生产 migration 的控制与旧候选排除

真实 `migrateConfig` 对普通无版本的 image/video entries，按显式 `adapterKind + tag` 规则回填 catalogId，保留自有 defaultModel、已有 catalogId、未匹配 custom kind 和原输入字节序列；二次迁移稳定且 `changed:false`，version 1 不重跑 version 0 的回填。测试没有 sandbox 配置字段，没有 SettingsManager 或配置文件读写。证据：[fixture](evidence/migration-config-pure.test.ts)、[首次原始日志](evidence/migration-config-pure.first.log)、[首次退出收据](evidence/migration-config-pure.first.exit.json)：**4 pass / 16 expect / exit 0 / Completed**。v1→v2 helper 会走无 sandbox 的早退路径；这不验证 sandbox 行为。

通用 gap / future-version stamp 已是 [round4 C-SET-02](../audit-2026-10-17-round4/settings.md) 旧候选。生产 registry 仍连续 0→1→2，SettingsManager [manager.ts:416](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/manager.ts:416) 的相关片段仍过滤 stamp-only 差异。本轮不重复登记，不构造自定义循环 migration，不运行该候选或当前 Manager 的持久化链。按 kind/tag 回填是 [migrate-config.ts:28](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/migrate-config.ts:28) 的明确兼容语义，未因为 synthetic 自定义 endpoint 被选到 builtin catalog 就另造 bug。

## 覆盖、查重与跳过

[历史查重](evidence/migration-dedup.json) 实际扫描全部 `docs/`、`bugs/` 下 **1825 个 MD/JSON 文件（1102 MD、723 JSON）**，递归解析 **281762 个 JSON 叶子，0 parse error**，包含 archive/_archive，排除本轮目录。主模式命中 migration 110、parse-source 427、manifest 71；另追加 suffix-boundaries 45 个历史匹配。命中内容已阅读相关 audit/review 行与 round4、round8 报告；未找到该 `.git` 边界候选的旧登记。旧 transport policy、R8 marketplace 引号/Windows 名称、R4 YAML 保存及 migration providerKey 候选均不重验或计新项。

完整静态阅读 `migrate-config.ts`、`parseSource.ts`、`normalizeManifest.ts`、相关 migration/source tests 和 installer manifest types；选读 builtin catalog、manager/schema、CLI 和 import dependencies。具体文件哈希和阅读范围见 [source manifest](evidence/migration-source-manifest.json)，列出的依赖文件不代表完整模块审阅。`normalizePluginManifest` 的导出实现带 manifest/asset 文件读写，超出本轮纯内存元数据范围，因此仅静态核验，没有运行归一化、文件读写或安装。没有测试真实 UI/CLI/Engine、远端 Git/npm、资产解码、普通配置写盘、权限/认证/安全策略或完整 package/repo suite，也没有 build/typecheck/lint。

metadata 查询有三次失败：猜历史 fixture / runner 环境模块路径，以及首次测试通过后可选的 Node root semver package metadata resolve，原始工具响应转录见 [navigation skip](evidence/migration-navigation-skip.md)。三者均不涉及 Bun、产品导入或断言；相应引用/可选查询已跳过，没有修复或重试；未固定 installed semver 版本/路径，不从 Node root resolve 的失败推断 Bun 模块不可用。两组新 fixture 使用已核实的绝对产品路径；[运行前 metadata](evidence/migration-preflight.json) 只核对文件存在、字节与冻结 Git blob，不执行产品。真实函数导入之前 fixture 阻断 fetch/http/https/net/tls；source fixture 另阻断 child_process 执行 API。这只是所测进程 API 的保护，不是 OS 沙箱或安全验证。

所有原始 combined stdout/stderr 与 exit 收据先保存再查看，没有失败的产品测试、重跑或替代验证。测试断言记录当前候选观察和正常控制，没有实施修复。[validation](evidence/migration-validation.json)、[机器可读候选](evidence/migration-candidates.json)、[机器可读 findings](evidence/migration-findings.json)、[artifact receipt](evidence/migration-artifact-receipt.json) 完成本专项交接。
