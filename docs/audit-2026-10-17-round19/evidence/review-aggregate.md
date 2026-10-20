# 第十九批聚合独立复核

冻结点 `5f5cf69df8526470700712a4dc2d5ae6bd2da132`；复核时 worktree/main HEAD 均为 `40141406c1314510a9ed6d6fbd851e1822e6530f`。读取 README、coverage、分类 JSON、validation、source manifest、worker integrity、evidence index、integration plan、四个 scope reviews、相关首次收据与 metadata 说明。只写本文件；没有导入产品、运行测试/新实验、产品命令或 Git 写入。`git show`/diff/rev-list 仅作只读审查元数据核对。

结论：没有阻塞本批文档集成的问题。聚合为 **1 项 P3 / 0 候选 / 2 related**，与 worker 原始数组逐项一致。`REVIEWPROMPT-R19-01` 有提示/解析矛盾的实际叶观测和完整名称对照；CLI/UI chain 是静态证据，未扩大为实际命令、模型漏报或已经修复。两个旧机制保持静态 related，不重复计新增缺陷。其余零项只表示有限范围未建立可登记缺陷。

四条互不重复的首次 raw 与 exit/command/SHA 一致，均为 guarded runner、Completed/exit 0：**29/49 + 15/44 + 10/37 + 17/57 = 71 tests / 187 expect**；**43 existing + 28 focused**。每组现有/聚焦合计与 raw passed 数一致，0 fail/skip/rerun。仅两个 reviewprompt characterization 断言当前错误行为。Timing 受控数字时钟、simple diff 小字符串、undo 自有元数据均未被扩大为 Engine、recorder、FileHistory、恢复文件或 renderer 的运行覆盖。默认/异常系统时钟、非法限额参数和 legacy 当前 producer 的限制保留。

独立重新核对：**71 个 indexed files / 72 个含 index 的文件**，无重复/遗漏且所有 SHA/bytes 匹配；**42 个唯一全局 source pins** 的 frozen/current/main 字节和 SHA 全同；**45 项 worker source checks** 与各原 manifest 对应行匹配；**38 个 worker artifacts** 与作者 receipts SHA/bytes 一致；现有全部 Markdown 的 **93 个本地链接**在独占 worktree 中存在，引用行不越界。文件 hash 没有被当作未读大文件或传递模块的全面覆盖。

复核的 index SHA 为 `f9d2dd3f5a41a394dc2788c1d9a1d8e8f976bcb1b06443eeb36d7eb8b49a94d0`。本 review 写入会新增一个已知文件，Root 应重新 assemble/index/verify，并在 staging 前再次检查；上述 71 / 93 是本 review 写入前的观测，不声称它们是最终文件/链接总数。最终 staged/blob/primary fast-forward 验证尚属 Root 后续步骤。

四个 scope reviews 的计数、运行边界与本次聚合相符。Reviewprompt 补齐 TuiControlSurface 静态转发、timing publisher 范围修订/不存在 glob、root 文档导航及 README metadata patch/只读输出截断、frontier capacity 调度失败均有单独记录；没有用它们触发产品重跑。旧 recorder、TUI Diff、parser/dependency 失败方向继续跳过，simple-diff O(n*m) 方向完全排除。

全历史 2,050 文件、260,970 string leaves / 363,859 scalar leaves 与 worker 去重记录一致，且总命中数和 contexts cap 分开。外部 main 只前进两条提交，Git 元数据确认唯一变化路径为 `docs/todo/release-real-operations-2026-10-16.md`；42 个已选 source pins 仍等于冻结字节。prior inventory 是读取当时快照，没有要求 release 文档当前 SHA 必须与旧库存一致，也没有新旧修复验证结论。

integration plan 与初始/合并前快照对应：HEAD 从冻结点变为并发 main，其余 dirty status、tracked/staged diff hash 和四个 untracked 文件的 path/bytes/SHA 全相同。计划只允许 incoming 本批 docs 且最终 HEAD/dirty 快照再次匹配时 fast-forward；未宣称已集成，未修改 primary。旧 bugs 文件在 primary 的预先删除应继续保留；本次链接检查是在独占审查 worktree 上进行。

## 本次只读 metadata 错误与修订

首次辅助批读正确读出 `integration-before.json`、`integration-premerge.json` 后，误猜第三个文件名 `evidence/main-refresh.json`；该命令 exit 1，首响应为：

```text
FileNotFoundError: [Errno 2] No such file or directory: 'docs/audit-2026-10-17-round19/evidence/main-refresh.json'
```

该不存在路径已跳过，没有重试/创建或寻找同名替代，也不计为 Bun/依赖/产品失败。之后按实际 evidence index 库存、已有 integration plan 和只读 Git metadata 核对上述外部变更事实。

首次独立 collector 已通过当时 index 和全局 source pins 后，在 worker manifest 检查中错误假定所有 row 都用 `frozenSha256` 字段；Root manifest 实际使用 `sha256`、`frozenBlobVerified`、`currentMatchesFrozen`。首响应为 exit 1：

```text
Traceback (most recent call last):
  File "<stdin>", line 34, in <module>
KeyError: 'frozenSha256'
```

已读取实际四份 schema，并仅修正 metadata collector 的字段分支，再执行本节所述字节/收据/链接/快照核对，结果全部通过。第一次 collector 失败没有改写任何报告/receipt 或产品文件，review 当时尚未写入。此修订没有恢复失败产品方向，没有导入产品或生成替代测试证据；本次产品执行、产品重试和 Git 写入均为 0。
