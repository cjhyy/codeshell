# 原 CC 批 4：剩余验收 runbook 与决策清单

2026-10-26；交回原 CC `3e34f601-e67b-4de4-a43f-eba9cf0283f3`。
当前四批[2026-10-27 组合](audit-integration-20261027.md)已获原 CC 最终组合验收 PASS，已快进合入本地 main；未推送、未发布。
本批来源阶段只完成本地技术准备，保留以下历史事实；不批准版本选择、生产迁移、预算或解冻
2026-10-09 的 Link 暂停。本文给出下一次执行所需输入、步骤、通过判据和失败回执，
不是已经执行这些操作的记录。

## 一、来源阶段证据与当前候选边界

主仓文档基线 `2035c0a30f51c37415814b340c364fee490e667f`，分支
`codex/docs/audit-remaining-runbooks-20261026`。它已有大历史恢复及新 external-runtime
memory 的本地集成；后者见[准确交付](external-runtime-memory-20261026.md)，
不再沿用旧审计“外部 memory 全未实现”的判断。本批没有修改 runtime/memory 代码。
既有 v0.9.46 发行仍绑定 `c7f108ee4`，不能用本地新 main 代替发行包来源。

| 批次 | 用户交接的本地证据 | 真实边界 |
| --- | --- | --- |
| 1 NSIS holder | 独立 `codex/desktop/nsis-uninstall-holder-20261026`；原 CC PASS 196 | 来源未提交，代码已转入组合候选；不是 Windows 16 阶段或正式安装证据 |
| 2 Mobile 大旧基线分页 | 独立 `codex/web/mobile-legacy-base-pages-20261026`；PASS 361 | 来源未提交，代码已转入组合候选；不是实体手机、真包冷启动证据 |
| 3 首窗 probe / 本地 WER collector | 独立 `codex/desktop/windows-launch-diagnostics-20261026`；PASS 161 | 来源未提交，代码已转入组合候选；不是已有 dump 或 `0xC0000005` 定位结论 |
| 4 本文 + Panel ZIP 工具 | Panel 基线 `84348855be8ae4e5a31936b3c2b0d1d21410bd64`，独立 `codex/panel-shared/verify-release-zip-20261026` | 来源只读技术核对；主仓仅文档；原 CC 二轮 PASS 52/0，当前组合已获最终验收 PASS 并合入本地 main，未推送或发布 |

表中独立 PASS 保留来源历史，不能相加作本轮组合结果。当前 Host 组合基线为
`2035c0a30f51c37415814b340c364fee490e667f`，分支
`codex/core/audit-integration-20261027`；Panel 组合基线为
`d15a35bec1910c0a55be7b737a5343314635d4a2`，分支
`codex/panel-shared/release-zip-integration-20261027`。本轮已按审阅 patch 与明确新文件
组合，保留新 memory 与其他本地主线工作；实际去重回归、候选提交与未完成项以
[2026-10-27 组合候选](audit-integration-20261027.md)为准。来源四个 Host worktree 与 Panel 来源仍完整未提交保留。
这些任务候选不是正式包、六 Panel freeze 或原生验收结果。

每次验收先建立一份 create-only 私密回执：`caseId`、UTC、操作者、授权范围/截止、
三个仓库准确 SHA、OS/架构、锁文件与实际 build receipt、installer/app/ASAR/Panel ZIP
SHA-256、命令、退出码、实际执行阶段、数据目标与回滚目标。敏感路径/身份只存本地
私密原件，对外仅脱敏摘要；失败也保存回执，不覆盖前一次成功/失败，不删旧工件。
unit 必须隔离 HOME/XDG/凭据：Host 用 `run-bun-test-shard.mjs` /
`run-isolated-node-smoke.mjs`，Panel 用 npm 与其独立 HOME 白名单。环境隔离不是 OS
网络沙箱，更不是允许访问真实账号。

## 二、正式环境验收 runbook

### A. Windows：先组合候选，再验 16 阶段与首窗/dump

**输入/授权。** 需要上一节的准确组合 `host_sha`、Windows x64 独占测试机、操作者、
允许创建的新证据/安装目录及时间窗。NSIS 现合同仅接受真实 GitHub-hosted
`windows-2022`（`ImageOS=win22`）；不能伪造环境变量在当前 macOS 或个人 Windows
机器绕过。要触发远端 workflow、打安装包或安装，必须另获明确执行授权；本批没有。
先将批 1 holder、批 2 Mobile、批 3 probe/collector 与当前 main **一起**组合验证；
不能将三份分支的单独 PASS 相加当最终包 PASS。

**步骤。** 在获批的干净准确候选上按 Bun 锁文件构建；当前实际入口来自
`.github/workflows/desktop-ui-acceptance.yml`，以下是后续执行命令，未在本批运行：

```sh
bun install --frozen-lockfile
bun run packages/desktop/scripts/build-workspace-dependencies.ts
bun run --cwd packages/desktop build
bun run --cwd packages/desktop predist
node packages/desktop/scripts/smoke-local-package.mjs --output <new-private-package-dir>
node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/e2e-startup-operation-cycles.mjs --evidence-dir <new-private-startup-dir>
node packages/desktop/scripts/run-packaged-ui-acceptance.mjs --build-receipt <package-dir/build-receipt.json> --evidence-dir <new-private-ui-dir>
node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/smoke-windows-nsis-install.mjs --build-receipt <package-dir/build-receipt.json> --evidence-dir <new-private-nsis-dir>
```

上述依赖构建、Desktop build、predist 必须串行完成；本批不安装依赖或执行构建。
`smoke-local-package` 读取已构建且物化依赖的输出；它不替你编译/predist，且关闭 publishing、notarization、
developerIdentity。`run-packaged-ui-acceptance` 验 `sourceHead`、clean source、原生 OS/
架构、ASAR 与 managed Node manifest；不能把旧 receipt 指向新候选。组合前只可做离线
合同测试，例如 `node scripts/run-isolated-node-smoke.mjs --test <明确的批1/3测试文件>`；
不通配发现，也不在真实 HOME 直接跑 suite。

现 `smoke-windows-nsis-install.mjs` 的 16 阶段必须逐项都有成功回执：

1. preflight → baseline → stage-copy → toolchain
2. nsis-build → payload-identity → install → installed-identity
3. installed-ui → replacement-marker → replace → replacement-identity
4. replacement-ui → uninstall → cache-cleanup → final-integrity

批 1 的 holder 合同组合后，仍须证明 holder/target 准确 PID、PPID、birth、nonce 与
target/holder exit、watchdog cleaned，不能用迟到 exit 0 补初始身份。完整 16 阶段现仍
只证明 unsigned、silent per-user 和同构建替换；不是签名/SmartScreen、GUI Finish
自动启动或跨版升级。

**首窗与失败保留。** 批 3 的 `e2e-ui-packaged.mjs` 沿用真实 hosted Windows x64/win22
门禁，在首次 `findCodeShellWindow` 失败后，对 captured child 至多进行一次 3 秒窗口
白名单采样。沿用现有 `node packages/desktop/scripts/run-packaged-ui-acceptance.mjs --build-receipt <同一回执>
--evidence-dir <新目录>`；没有额外 probe flag，不手工伪造 hosted 环境变量。
显式本地 collector 的真实 CLI 如下（本轮没有原生执行）：

```sh
node packages/desktop/scripts/windows-wer-dump-evidence.mjs --help
node packages/desktop/scripts/windows-wer-dump-evidence.mjs --source <已存在的绝对私密源目录> --output <已存在的绝对私密输出目录>
```

目录与全部祖先须普通非链接，source/output 不同且不嵌套；已有同名输出或
`wer-dumps.json` 拒绝覆盖。工具只从显式 source 只读复制有界候选并生成清单，不默认
发现 WER、不设置/恢复注册表或 ACL、不生成或分析 dump，也不证明 PID/birth 归属。
现有 `windows-nsis-crash-evidence.ps1` 仍只收集有限只读 Application Error/WER 元数据。
若未来另行配置 LocalDumps，须另获授权并独立记录配置与恢复证据。

若失败，保留 build receipt、journal/checkpoints、process-custody/settlement、
snapshotTiming、renderer-loads、stdout/stderr、UTC 窗口、进程与异常码、模块/地址、
installer/app/ASAR SHA 及 collector 清单、截断状态与文件摘要。probe 只定位最先缺失的
里程碑；`0xC0000005` 必须有与准确进程/构建关联的 dump 和对应符号分析才能定位。
dump 可能含提示、token 和业务数据，**仅本地受限保管**；不得默认放公开 CI artifact、
Issue、Release 或 Git。需分享时先单独批准对象、脱敏内容和保留期限。
失败不扩大进程清理范围，不按名字 taskkill，不丢原 dump、不删历史工件。

### B. 签名与公证：配置身份和验签各自有证据

**输入/授权。** 用户提供证书保管位置/负责人、发布者身份、有效期、允许的构建 SHA /
平台和签名执行范围；不在聊天索取 p12、密码、token 或 Secrets 值。
Windows 需要可用的代码签名证书/私钥（含所需硬件/云签方案）及对应配置；当前
`release.yml` **没有 Windows signing secrets 映射**。若采用文件证书，建议后续审批
`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD` 名称及仅 Windows job 映射到 builder
`CSC_LINK`/`CSC_KEY_PASSWORD`；这些是待配置建议，不是已经存在或已获准的 secrets。

macOS 已有映射名字：`CSC_LINK`（Developer ID `.p12` 的受保护输入）、
`CSC_KEY_PASSWORD`、`CSC_NAME`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、
`APPLE_TEAM_ID`。当前 `after-pack-adhoc-sign.cjs`、`managed-node-signing.cjs`、
`sign-managed-node-mac.cjs` 和 `after-sign-managed-node.cjs` 保留 managed Node 的
签名/摘要合同；本地 smoke 明确禁用正式身份和公证，不能凭 smoke 证明 Developer ID。

**步骤/通过。** 由负责人在受控签名机配置名字和权限，获准后构建指定 SHA，保存
安装器和 app 的摘要。Windows 分别对安装器与安装后主 exe 用
`Get-AuthenticodeSignature -LiteralPath <file>`，要求 `Status = Valid`，并核对批准的
publisher/证书 thumbprint、证书有效期与可信时间戳。`NotSigned/UnknownError` 不通过。
macOS 分别检查签名链/TeamIdentifier、app 完整性、Gatekeeper 和票据：

```sh
codesign --verify --deep --strict --verbose=2 <signed.app>
codesign -dv --verbose=4 <signed.app>
spctl --assess --type execute --verbose=4 <signed.app>
xcrun stapler validate <signed.app>
xcrun stapler validate <signed.dmg>
```

`spctl/stapler` 是补充的正式人工验收命令，**现有仓库脚本没有自动执行它们**。
`stapler` 验 app/DMG，ZIP 用内含 app 验；不得声称可对 ZIP staple。记录每条退出码、
接受的 Developer ID/Team、票据/公证结果及实际分发介质。失败保留签名输出、摘要和
未通过阶段，不公开私钥、不为了通过改为 ad-hoc，也不自动重发 Release。

### C. 0.9.44 → 0.9.46 真升级与回滚

**输入/授权。** 明确 OS/架构、两个既有正式资产 URL/SHA、安装/更新权限、独立 OS
测试用户、测试用数据和允许的新目录。后续若测试组合候选，应单列 `.46 → candidate`
用例，不能重用 `.44 → .46` 版本名字冒充。

**步骤。** 先验证 `.44/.46` 来源与签名；安装 `.44`，建立唯一 `caseId` 的 Session、
可核对消息/附件摘要、项目绑定与一个不含秘密的设置标记，正常退出并做完整可恢复
备份。通过真实批准更新入口升级到 `.46`（记录下载、安装、重启和实际运行版本 /
二进制摘要），冷启动后读回相同 Session ID/消息/附件/设置。再写一个“升级后”新标记。
退出后保留最新数据完整副本，在**另一个新目录/测试用户**验证旧代码兼容性；若旧代码
无法读新格式，回滚到 `.44 + 升级前数据副本` 并明确新标记只在归档中，不承诺无损。
兼容代码回滚则必须读取最新副本并保留两个标记，不能覆盖当前目录试错。

**判据/失败。** 版本与包来源准确、跨重启 Session/附件绑定不串项目、升级后数据可
读、回滚语义与实际结果相符；保留最新副本和失败副本的 digest/格式/错误回执。
`e2e-updater-packaged.mjs` 仅访问 owned loopback feed，明确不下载/安装更新；现有
same-build NSIS/DMG 替换均不能关闭本项。失败禁止用旧快照覆盖最新数据来“修复”。

### D. Linux Services：准确输入、容量与范围先确定

以 Services 当前 `.github/workflows/candidate.yml` 为准，实际参数名为
`host_sha`（**值须完整 40 位 SHA**，不是名为 `host_sha40` 的输入）、`panels_sha`
（同为 40 位），`real_speech=false`。另记录 Services workflow 所属精确 SHA；
`host_sha` 必须是 A 的最终组合，`panels_sha` 必须是用户选定且 package gate 通过的候选，
不能拿此次 ZIP 工具基线替用户 freeze。

获批触发前先只读查看 Actions storage/quota、已用/可用量、单次预计大工件大小和
retention，记录查询时间与实际上传限制；工件当前 candidate 保留 14 天、evidence
7 天。额度不足则保留容量查询与失败回执，等用户决定额度/保留策略；**不删旧工件**。
获准执行时再填写准确参数运行既有 workflow。其现实际调用为：

```sh
node host/scripts/smoke-services-cloud-entry.mjs <services-checkout> --panels <panels-checkout> --docker --output <new-private-output>
node services/scripts/verify-candidate.mjs <new-private-output>
node services/scripts/load-candidate-images.mjs <new-private-output>
```

后两者是该 workflow 的验证/本机镜像加载步骤，不是部署授权。当前脚本含历史 Cloud
Panel 组合；2026-10-14 冻结云端工作区/Panel 的决定仍有效，审批时须标明是复验既有
历史合同还是薄云端所需子集，不能因此开新云端 Panel 业务。保存三 SHA、镜像 digest、
page-errors、实际退出码与上传结果；小工件成功不代表大工件通过。Linux 现仍未重跑，
本批不触发 workflow、安装依赖/系统包、构建镜像或 CI。

### E. GitHub 严格单仓真实 consent 与 Keychain

**单仓输入。** 用户明确批准真实账号、可信 Link origin、客户端、只读 actions、仅 A
仓 `owner/repo`、一个明确不允许的 B 仓、有效期与撤销人。历史 consent 实际选了两仓，
`exactlyScoped=false`、单仓 probe `not-run-scope-differed`；见 Services
`docs/github-login-link-target-deployment-2026-10-12.md`，不能当作单仓通过。

**步骤/通过。** 用户亲自在 consent 仅选 A，并只授予 `github.get_repository` 与
`github.list_repositories`（原 grant 若只有 get，就必须重新明确 consent 才能 list）。
读取 `GET /api/v1/data/authorization` 的授权元数据，`grant.resources` 必须仅 A；经正式 Host/Link 只读 action，
list 恰好一个 A，get(A) 成功，get(B) 返回 HTTP 403 + `repository_not_allowed`。
Services 实际 action 路由为 `POST /api/v1/data/connections/<uuid>/actions/<action>`，
HTTP POST 承载只读 action，不代表允许创建 Issue/写 repo。凭据由现有安全通道注入，
不用命令行 literal token，不写入回执。记录动作、资源摘要、status/错误形状并撤销本次
临时 grant，复测已撤销访问被拒。多仓 list、scope 不足或 403 原因不同都不能算通过。

**Keychain 输入/步骤。** 单独批准真实 macOS 测试用户、准确签名安装包/Team、只读
测试账号和撤销范围。由用户处理 OS 弹窗；代理不能点击允许/提供密码。先记录
safeStorage availability、受保护 ciphertext/条目摘要，正常退出所有该测试用户拥有的
app/worker，冷启动后同账号只读访问成功；执行 logout，再冷启不得复活旧 session；
另测服务端 revoke 后访问失败，重新 consent 才恢复。保留 UTC/版本、cold PID、
摘要/拒绝回执，不能保存秘密值。

现有合成 HMAC/safeStorage 冷重启有受控证据，参见
[Keychain 验收](macos-keychain-acceptance.md)。其复现入口为
`node packages/desktop/scripts/macos-keychain-context.mjs --capture <new-private-reference.json>`，
再 `node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/run-macos-keychain-acceptance.mjs --default-keychain-reference <reference> --output <new-private-dir>`。
这是有 OS Keychain 触达的独立验收，**本批未执行**；私有 HOME 不隔离 OS Keychain，
不得把此合成 gate 或 AES 本地存储推定为真实账号/正式签名器验收通过。

### F. 旧 owner 显式迁移：先生成新目录，再单独批准切换

Services 仅只读，按其 `docs/account-device-migration.md` / 已有
`scripts/account-migrate-device-relay.mjs`；不是本批执行计划。
用户需明确可信 `expectedLegacyOwnerId`、`targetAccountId`、完整 legacy 备份中全部电脑的归属、四个
origin、两份完整停机备份与新目标、服务用户、时间窗、验证/切换/回退负责人。
工具处理整份 legacy 备份的全部电脑，不支持选择其中子集迁移。
不能按用户名、第一条账号或设备名称猜 UUID，也不能复制账号库让两进程互认。

1. 获批后停止旧设备目录和独立账号服务，用现有 `device-relay-backup.mjs` 与
   `account-backup.mjs` 各生成一份完整私密备份；保留来源、origins、schema、摘要。
2. 写服务用户所有的普通 plan JSON（0600、≤16 KiB），字段必须精确为
   `publicOrigin/deviceBaseOrigin/legacyPublicOrigin/accountPublicOrigin/legacyBackupDir/`
   `accountBackupDir/destinationDir/expectedLegacyOwnerId/targetAccountId`。
   路径必须绝对、互不包含；destination 不存在。私密 plan 不提交。
3. `node scripts/account-migrate-device-relay.mjs <private-plan.json>`，只生成新目录；
   使用 `DEVICE_RELAY_AUTH_MODE=account` 与新的 `DEVICE_RELAY_DATA_DIR` 在隔离入口
   启动候选，不同时启动源/目标 authority。
4. 检查账号 UUID/GitHub numeric identity、设备 installation/电脑/environment ID
   保留；旧账号/设备凭据和票据失效、epoch 前移；目标账号重新登记同 environment
   后电脑 ID 保持，另一账号不可看/认领/撤销。补真实电脑出站和实体手机访问。
5. 新 directory、登录路由必须指向同一个 account authority；完整成功并审阅后，
   **另行批准**切换 origin/服务数据路径及 OAuth/Link 交接，不把离线成功当线上通过。

失败保留原目录、两份备份、plan 的私密原件/公开摘要和隔离标记；不手删标记绕过。
切换后的新账号/密码/撤销/设备数据不回写旧库。代码回滚先在最新数据副本验证 schema
兼容，不能直接启旧目录丢失最新数据。本批不创建 plan、不停机、不迁移或切换。

### G. 恢复演练：选择真实 target，新目录验证完整业务

**审批输入。** 选择 Account / 账号模式中继 / legacy device relay / Link 的具体服务，
现网 origin、精确 deployed SHA/依赖/镜像 digest、运行用户、源目录、可信新备份位置、
从未存在的新恢复目录、验证隔离入口、维护窗口、RPO/RTO 与回滚责任人。Account/Link
已有部署记录，缺的是**这次演练目标与执行授权**，不是泛称“入口待确认”。

| 已有 Services 脚本 | 必须匹配的配置与动作 |
| --- | --- |
| `node scripts/account-backup.mjs <source> <new-backup>` → `node scripts/account-restore.mjs <backup> <new-destination>` | `ACCOUNT_PUBLIC_ORIGIN` 相同；账号模式中继加 `ACCOUNT_RECOVERY_MODE=relay`、`DEVICE_RELAY_DEVICE_BASE_ORIGIN`，整个中继停机备份 |
| `node --env-file=<private.env> scripts/device-relay-backup.mjs <offline-source> <new-backup>` → `scripts/device-relay-restore.mjs <backup> <new-destination>`（同样用 node/env-file） | `DEVICE_RELAY_PUBLIC_ORIGIN` / `DEVICE_RELAY_DEVICE_BASE_ORIGIN` 与原 audience 相同；停机，源目标不同时启动 |
| `node scripts/link-backup.mjs <source.sqlite> <new-backup.sqlite>` → `node scripts/link-restore.mjs <backup.sqlite> <new-dir/link.sqlite>` | Link backup 为 SQLite 原生在线 backup，0600；同一个 `LINK_MASTER_KEY` 由服务安全环境注入，单独托管、不索取值；恢复目标先离线 |

具体合同见 Services `docs/account-recovery.md`、`docs/device-relay.md`、
`docs/deployment.md` 的备份恢复节。禁止直接复制活跃 WAL 库、覆盖现有目标或只检查
`/health`。以下按选定服务分别适用，不把另一服务的字段当作通过条件：

- Account：核对 manifest 清单/长度/SHA、SQLite integrity/FK/精确 schema、账号
  UUID/GitHub identity 保留，旧 session/access/refresh token 撤销，实际重新登录与其他账号隔离。
- 账号模式中继 / legacy relay：另核对设备 installation/电脑/environment ID、固定
  deviceBaseOrigin、设备票据/凭据撤销与 epoch 前移，原 environment 重新登记保持电脑 ID、
  实际出站/设备访问；账号模式中继同时满足 Account 条件。
- Link：保存备份数据库摘要，核对 integrity/FK/schema/master-key 匹配（不是 Account
  manifest）；恢复到 schema 3，旧浏览器/管理 session、下游 grants/tokens 撤销，实际
  重新登录/逐应用 consent，再执行只读动作与撤销验证。上游 token 若已轮换须重新连接。

各服务分别记录 RPO/RTO；不能用备份使已撤销授权复活。

完整成功后才能单独批准切正式数据路径。恢复失败保留退出码、摘要和脚本的失败/
隔离回执；Link 脚本可能自行删除**本次失败的新数据库**，这是现合同，不为验收去
改脚本；保留源备份/旧目标/日志，绝不删旧工件。代码回滚在最新数据的独立副本上
验证 schema 和实际业务，保留新数据原件；恢复旧快照造成的数据损失须明确标记。
云端项目 volume/持久工作区冻结，不扩展本次目标。仓库未找到 pushgateway 实现，
也没有可用的推送网关部署证据；不能把 Account/Link 的 health/恢复外推成完整云端。

### H. 六 Panel 重新 freeze：只列事实与缺口，不替用户选版本

Panel 已增加 `scripts/verify-release-zip.mjs --tag --zip --dir`。`--dir` 是准确 tag 内
安装目录；Video 用 `panels/video-studio`，不是 `apps/video-studio`。本地只读、
不 extract/exec/network，逐文件 SHA、manifest ID/version、路径/CRC/预算校验；
exit 0 一致、1 差异或生成物不完整、2 不合法/不支持。生成物缺失不能称字节一致。
工具与完整交接位于 [Panel 仓](https://github.com/cjhyy/codeshell-panel-apps)的上述独立分支，
来源当时仅本地未提交；当前工具已转入组合候选，仍不能将未发布的分支 URL 当作已可下载交付。
可移交的仓内文件名为 `docs/acceptance/panel-release-zip-20261026.md` 与同名
`.evidence.json`，不依赖 disposable 绝对 worktree；CC 可在该分支验收或随补丁接收。

| 当前 Panel manifest（基线 8434885） | 同版本 tag / 证据状态 | 安装目录相对 tag（不是 ZIP 差异） |
| --- | --- | --- |
| Design 0.23.0 | `design-studio-v0.23.0`，已下载现成正式包核对 | 47 路径变化 |
| Job 5.1.0 | 本地无 `job-hunt-hq-v5.1.0`，本批未取正式 ZIP | 未建立同版本 tag 对照 |
| Quant 0.47.0 | 本地无 `quant-lab-v0.47.0`，本批未取正式 ZIP | 未建立同版本 tag 对照 |
| Download 0.24.1 | `video-download-v0.24.1`，已下载正式包核对 | 5 路径变化 |
| Video 0.8.0 | `video-studio-v0.8.0`，已下载正式包核对 | 10 路径变化；原 gate 的 5 路径假差异是软链依赖环境问题，I1 整改后通过 |
| Starter 0.1.1 | 本地 tag `starter-panel-v0.1.1`；本批未下载 ZIP | 6 路径变化 |

本批先查询真实 Release API 的 URL/name/digest，再只读 `gh release download` 到
私有目录；三 tag 已在本地，无需 fetch。准确正式资产结果：

| tag commit | asset SHA-256 | 逐文件结果 |
| --- | --- | --- |
| Download `09fd3bd3b0b9c6bb286b54e2f2d7c47a4ac0520c` | `2000d17bc416944e9176e8c7891cea5644d03ac0a5ae9a38354d73250bc69a4e` | 34 files，0 differences，exit 0 |
| Video `7850d680686d62ddc35d539319bf88353a7dc54f` | `7d21e60a3ce56549c8c21a11c7bc922705ceac1e01695a9c993b92b9035af0a8` | 41 files，0 differences，exit 0 |
| Design `2202581190b5b5abe3e1a8124e2a6c36a95b7e4e` | `c8e7790c87e24899aadb7fc78c8a9afe0c54b27660965d083ed421faa633a0d5` | 145 files，0 differences，exit 0 |

上述分别来自既有 [Download](https://github.com/cjhyy/codeshell-panel-apps/releases/tag/video-download-v0.24.1)、
[Video](https://github.com/cjhyy/codeshell-panel-apps/releases/tag/video-studio-v0.8.0)、
[Design](https://github.com/cjhyy/codeshell-panel-apps/releases/tag/design-studio-v0.23.0)
Release。ZIP 容器 SHA 与 API digest/size 匹配；文件内容与 tag 比较，不能说 ZIP
容器与某个重新打包产物逐字节一致，也不证明当前源码生成物一致。

首次在 `node_modules -> ../../node_modules` 软链环境下实际运行
`npm run check -- --suite release-zip` exit 1，先通过共享/插件/CanvasKit/types，
报 `video-studio: committed package is stale` 并停止，尚未运行 suites；
committed vs rebuilt 的 5 个文件：`.codeshell-panel/panel.json`、
`app/build-manifest.json`、`app/tools/editor-runtime.mjs`、`app/tools/editor-sync.mjs`、
`app/tools/video-studio.mjs`。**此前将其诊断为已提交包过期、建议重建 Video 是错误的，
现撤回该建议，无需重建 Video。** CC 对 `git archive 8434885` 两份相同基线的独立
clone / 软链依赖对照证明，差异来自 esbuild realpath 模块路径注释及连带摘要；独立
clone 的 Video build-check exit 0，软链 exit 1 且同样 5 路径。此对照为 CC 独立证据。

2026-10-26 I1 整改仅移除本任务创建的软链本身（不动目标），用 `/bin/cp -cR` 克隆
独立依赖目录，再在隔离 HOME/XDG/TMPDIR、清凭据、npm offline 环境重跑上述 check，
**实际 exit 0，52 pass / 0 fail / 0 skip**；Video 输出
`deterministic, committed package matches source`。没有更新任何生成包，
`git diff --name-only HEAD -- apps panels templates` 前后为空，工具/测试/锁文件等保护
SHA 不变。原 `check-release-zip.log` 原样保留；新日志为 Panel
`artifacts/verify-release-zip-20261026/i1-independent-dependencies-20261027/check-release-zip-independent.log`，
SHA-256 `e7f9b736a8733b2c0f4a2f8b33b4bf7eaa02812f2370737a06cc02cb7d47618e`，
同目录有独立 clone / check 回执。`npm run validate` 的既有 exit 0 保留；本次只选择
release-zip suite，不能声称全量领域 suite 已跑。

下一步由用户逐包批准 `panelId/版本/准确 sourceSHA/安装目录/tag/ZIP SHA/manifest权限/
Host API 下限/升级回滚数据样本/目标设备`；I1 不要求重建 Video，在用户确认的同一
freeze 候选及独立依赖环境通过 package gate 后，再做真实 Desktop/Hub 安装、权限
审阅、项目版本绑定、更新、冷启与回滚。六包分开收据；本地两种设备完整领域矩阵、
真实服务商与实体手机保留，旧四组合云端证据不扩大冻结范围。没有批准就不 bump/tag/
publish/install，不把这三份现成正式包通过当成六包候选通过。

## 三、Memory / runtime / lab 的最小推荐与批准字段

本节是维持现状的建议，不改实现、不激活新能力。当前 native/Core 已有自动提取、
摘要与既有 dream；Profile portable memory 已可手动读写/审阅后复制。新
`ExternalRuntimeMemory` 已在 main 注入：完成且持久化/输出完整/项目可信后冻结快照，
至少 8 条消息，Session latest-only 队列，180 秒期限；新前台回合会取消旧任务。显式
extractionModel/auxText 优先；Claude 跟随当前模型的无工具调用，Codex 无工具跟随
目前明确不支持，需用户显式 API 辅助连接。已有真实返回 usage/unknown 账本与归属
检查，不把它称为未实现或已随正式包发布。原 E04 的 skills/plugins/MCP 覆盖与三层
索引回注仍是不同边界；旧 parity 文档保留历史，以此处与新 memory 交付为准。

| 项目 | 维持现状的最小推荐 | 进一步批准必须写清 |
| --- | --- | --- |
| portable dream | 仅产待审建议；不自动写 portable profile。现 dream-consolidation 明确不接 profileMemoryDir/拒绝 profile 写入，已有 native 行为不改 | Profile/owner、来源 Session/run 与摘要、目标 scope/路径、建议 patch、reviewer/采用人、模型连接、token/金额上限、有效期、冲突及撤销策略；逐次人工选择采用 |
| 24h 调度 | 新 24h 能力默认 off；现 Goal 的默认 12 turns/30m、start 重置计数不能冒充跨续办总预算；现有普通 Goal 行为保留 | 任务 ID/owner、开始时间、绝对 UTC deadline、时区、所有续办共用的 turns/requests/tokens/USD/wall-time 总预算、单次预算、睡眠/唤醒条件、最大并发、暂停/恢复/取消与撤销负责人 |
| 外部 runtime MCP | 仅计划接**已启用 server 的只读 tool**，Run 开始冻结快照；不自动发现启用新 server、不给 vendor 自有 MCP 借用 Host grant | server identity/configHash、Profile/project/currentRun、精确 toolNames/参数/只读资源/数据发送范围、期限/撤销；改配置下 Run 生效。resources 另审，不把工具白名单等同全资源开放 |
| Panel.invoke 扩权 | 保持现有 reviewed Job Hunt tools；其他 Panel 逐 tool 白名单，不按 Panel 全开放 | panelId/version/packageDigest/toolName、参数/只读或写能力、资源范围、审批方式、有效期/撤销、重复/未知回执策略；CLI 可用不等于 invoke 获权 |
| 成本观测 | 只记录实际可取的 provider/Host receipt；vendor 未知成本/覆盖缺口保持 unknown，不套 API 单价或造逐请求记录 | 实际 requestId/model/provider/来源与时间、usage/成本返回可用范围、重试归集、定价依据/日期/货币（仅真实可得）、预算归属、正文保留/隐私与撤销 |
| optimization lab | 保持 `optimization_lab` 默认关闭；已有 P1/P2 隔离无工具实验与原生采用/撤销，不称未开始，也不由“全部技术准备”推定预算批准 | 精确 target/optimizer 模型名单与连接/configHash/credentialRevision（无值）、datasetHash/样本和 holdout/隐私、Skill hash/planHash/revision、评价/阈值、单次和累计金额/requests/tokens/time、并发、confirmedAt/expiresAt/startOperationId、撤销人；若没有定价依据不开始真付费 |
| Link 其余 provider | 维持 2026-10-09 暂停；只把 E 的指定 GitHub 既有目标列作待单独授权的验收，不启动其他连接 | 要恢复须用户明确 provider/账号/应用/所需 actions/资源/回调目标、凭据保管人、数据/预算/部署范围和期限；不能借此批概括授权解冻 |

源码依据：`packages/desktop/src/main/external-runtime-memory.ts`、
`external-runtime-service.ts`、`external-runtime-state.ts`，Core 的
`packages/core/src/services/dream-consolidation.ts` 与 `tool-system/builtin/memory.ts`、
`packages/pet/src/profile.ts`，以及 `packages/optimization-lab/src/contracts/experiment.ts` / `grant.ts`。
Lab grant 已约束 requests/executionMs/estimatedTokens/estimatedCostUsd；真模型前须冻结
名单与样本，明确单次及总金额，不写一个没有用户数值的“预算足够”。E05 真 Electron
reload 的 Stop 归属、E08 真账号审批仍须独立正式验收；本节没有替它们报 PASS。

## 四、本批验证与原 CC 接收

Panel 与 Host 串行写入，Services 只读。没有提交/push/合并/CI/Release/安装/Secrets
写入/真实 HOME suite/账号操作/生产迁移/付费/旧工件清理。只读审阅代理只提供证据与
安全 findings，全部编辑由主代理串行完成；其他 worktree 不动。

Panel：TDD 初红 46 fail（缺模块）→ 首实现 44 pass/2 fail → 修正 46 pass；补
partial-generated/Unicode 两项先红 2/2，再修复，最终 **52 pass / 0 fail / 0 skip**。
真实 ZIP 三份共 220 files、零差异；`npm run validate` 通过。首次 focused check 的
exit 1 原日志保留；I1 已确认是本任务软链依赖导致的路径注释假差异，并非已提交包过期。
替换为独立 clone 后，`npm run check -- --suite release-zip` 的完整前置门禁与指定
suite **exit 0、52 pass / 0 fail / 0 skip**。未修改工具源码或生成包，无需重建 Video；
全量领域/UI/media/Host 集成未跑。Panel 交接文档与 JSON 区分历史失败及整改后结果，
本地新旧日志和回执均保留 ignored artifacts。

Host 只新增本文并定点更新 TODO：`git diff --check`、相对链接/脚本/字段/阶段内容核对；
不为文档跑 build 或真实 HOME suite，不全量格式化历史 Markdown。验收后仍由原 CC
决定是否接受本地补丁、何时单独授权组合/正式执行；本批到此停止，不集成其他批。

## 2026-10-27 组合补记

本文件以上独立回执属于批 4 来源历史；来源 Panel 软链曾导致假差异，I1 已以独立
`cp -cR` 依赖修正且 check exit 0、52/0。当前组合依赖同样独立，未重建 Video 生成包。
本轮新证据与两个候选提交见[2026-10-27 组合候选](audit-integration-20261027.md)；真实环境与决策项仍保持未完成。
