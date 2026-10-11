# PR16-1 独立只读质量复核

Completed。只读核对最终 `/tmp/codeshell-review-20261012-project-recovery-round16.md`、root-repair.test.tsx及日志、两基线 Completed 收据、冻结a66f生产路径和R23/R24既有范围。**本复核新增测试0、断言0、native/Git/worker/model/网络实验0**，未修改产品、主报告、goal或构建。

结论：**建议保留独立P2**，限定“会话仍绑定已登记但物理缺失的secondary时，正式修复到健康同项目primary被旧source的全roots检查挡住”。它不是简单toast文案错误：用户确实提交了提供的修复按钮，合法目标已经验证，但修复必须先让本来需要脱离的旧路径重新有效。现有可恢复路径和无破坏保护必须一起保留，不能声称历史丢失、永久不可修复或已验证所有resident迁移。

## 正式入口及根因

- [Sidebar:1079](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:1079) 对非ok authority挑选不同于当前mainRootId的登记root，优先primary；[1111](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:1111) 提供实际 migrateSessionMainRoot(sessionId,targetRootId)，[1482](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:1482) 的“修复”按钮对dir_missing也显示。i18n core.ts124–126明确是“目录缺失/修复”，因此不是只宣称支持root_removed的隐含设计。
- Main真实 [registration:105](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:105) 接收不含cwd的精确ID，验证参数后从durable session取project；这条正确权威门禁不会拒绝fixture中的健康同项目target。
- [ProjectStore:355](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:355) 找同项目target，358先requireMountedProjectRoot(target)。真正拒绝来自 [367](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:367)→[workspaceContextFor:886](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:886)，逐个校验仍登记的所有root，包含已物理missing的旧B。错误在370 owner分支之前，所以bridge有无不会改变这次preflight失败；**这仍不等于已动态执行resident owner分支**。
- [removeRoot:316](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:316) 正确拒绝非归档会话仍绑定的root。与repair的全roots前提组合造成恢复循环：未迁移先不能remove，未remove且旧路径missing又不能migrate。它是明确业务修复路径的限制，不是任意越权输入要求成功。
- 既有 `project-store.test.ts:509` 的“repairs ... externally removed”测试实际在530–534**移除registry条目**，验证的是root_removed，不是保留registry而物理ENOENT的dir_missing。其通过不能反证此候选。已有466–506的missing目标拒绝同样正确，和健康target+missing source不同。

## 现有动态证据与保护

root fixture使用实际ProjectGroup/useVisibleSessionWorkspaces/ToastProvider、真实Main registration、ProjectStore、SessionCwdIndex、Core SessionManager、authority服务，真实rename旧B为parked。沒有伪造dir_missing或迁移错误，target A存在并已登记。首次实际button失败，error toast包含旧路径，state.json字节与index绑定不变，没有workspace success广播；实际removeRoot拒绝live绑定。恢复同一个原目录到原路径后，原button重试成功，cwd/project/mainRoot/workspace和index都更新，成功广播才出现。

第二用例未知target拒绝且state不变，真实symlink替换旧source时root_replaced拒绝，恢复direct directory后成功；这是值得保留的安全保护，不是另一个应放宽的误拒绝。

第三用例证明**不恢复旧路径也有服务级workaround**：实际Core归档owner→Main remove坏secondary→Core恢复→Main迁移到A，旧路径仍缺失，authority从root_removed回ok。源文件仍在parked，由fixturefinally删除；没有模拟用户文件损失。Core归档本身会让removeRoot的动态readSessionArchivedAt排除该owner，路径与源码一致。

两基线日志各是 **3 tests /27 expect/0fail/skip +Completed**，本次仅阅读收据，不累计为自己执行。原始latest `/tmp`日志也一致。无实际preload/IPC transport、完整Electron Main、native picker/TrustGate、worker/model、网络卷或Windows；getBridge=undefined，仅cold durable迁移动态。报告对此区分正确。

## P2与P3、恢复边界

P2成立的理由是主要功能“从缺失目录修复到可用目录”在合法目标下确定失败，不能通过同按钮直接重试、刷新、重开自然解除。恢复原路径对临时挂载/可回滚rename可行，但对于需要永久放弃旧路径的场景不是修复的普遍前提；另一个workaround需归档/移除登记/恢复/再次迁移多个不同入口，当前UI也未说明此组合。它超过一个额外确认或一次重挂的P3摩擦。

同时，应继续明确：错误可见、没有部分commit/数据删除；恢复原目录后按钮可用。service workaround不是已完整点击归档→目录管理→历史恢复UI；`workspaceArchiveRelease.ts:36–41`确认release失败后仍继续归档，但完整UI触达和历史状态同步只读核对，未被这个test覆盖。不能说所有用户必须手改配置、重启应用或永远无法恢复。若主审按“已有不明显的多步workaround”降低级别，P3也有可讨论余地；本复核按正式修复目标直接失效建议P2。

不扩大到primary缺失、无其他root、目录replaced、活跃工具/dirty worktree或未知目标；本例旧secondary缺失、健康primary、普通session。workspaceContextFor在其他run解析也使用全roots校验，本次没有该分支的独立动态输出，不再拆新项或声称所有健康新会话都已验证不能运行。

## 与R23/R24去重

R23在Panel discover批量预检或65项目IPC上限失败后，将空列表发布到当前renderer PanelRegistry，导致健康Panel App entries消失；不删除项目/包/绑定。这里没有Panel discovery、65项目、空注册列表，实际失败发生在session migration的workspaceContext构造，且state和registry保持原样。修Panel批量容错不会改变ProjectStore367/886；修迁移也不会修R23的清空。**两项应独立；同一workspaceContext的其它漏可用性情况本轮合为一项。**

R24是移除项目先tombstone后，cold owner的worktree release失去project authority；此处project仍live、target健康、旧B仍登记，失败在迁移开始前。普通目录和sessionMainRoot切换也无R35并发创建/回滚删除，不应混成数据风险。

## 修复安全边界

不能简单删除requireMountedProjectRoot或把旧B路径继续交worker。当前 [mounted-project-root.ts:115](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mounted-project-root.ts:115) 拒绝symlink/非directory/identity缺失，[125](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mounted-project-root.ts:125) 核对canonical identity，target验证应继续保留。

需要为明确修复迁移定义安全的有效mount集合：健康同项目target必须仍由Main稳定ID解析并重新验证；失效source及其它失效登记应被显式安全脱离或从本次运行context排除，并保留原登记/provenance/可恢复状态，不把未知路径升级成授权root。对resident owner继续先取得owner fence、确认不存在旧context下进行中的工作，再以durable session/project revision提交；现有396–422的not-resident权威重读与CAS、finally ownership completion不能因为解决preflight循环而被移除。

成功之前不能广播新workspace；失败继续保持原state/index与可见错误。回归至少保留当前healthy/invalid target/symlink/恢复原目录/归档workaround控制，并补真正dir_missing source的安全迁移成功，而不是把仅root_removed成功的旧测试误当覆盖。

## 隔离与清理

fixture入口检查guarded HOME，在Core/Host import前安装exact dummy loopback HTTP/fetch guard并deny directnet/tls；Git仅owned临时两目录init，系统/全局config指向/dev/null，未远程Git。其guard不是OS/子进程网络沙箱，报告已限定。afterEach卸载UI/Toast，清workspace-service注入、删除自有temp；guardedrunner清HOME。原始harness错误是portal文本查找，最终替身边界和3/27日志一致。没有新执行或操作其它进程。

**Completed：新增执行0，建议独立P2，保留上述恢复与安全限定。**
