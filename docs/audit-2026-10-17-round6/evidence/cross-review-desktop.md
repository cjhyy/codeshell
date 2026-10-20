# Round 6 独立交叉复核：构建/包元数据与 Skills/Agents

复核者：Desktop display 分审。冻结源码 `cef9ff76167d33a6a6e5b4464ba5313f7fd35f79`。本次只读报告、源码和已有日志/receipt，**新增测试/构建/native/网络执行均为 0**；没有修复或重跑失败 fixture，没有产品修改或 Git mutation。

结论：两份报告的 **0 新确认问题**及成功/失败证据分离成立。Root 的 17 项现有测试是一个干净完成的 guarded shard；Skills 的 13 项通过严格属于另一个整体失败的 shard，不能计入成功 gate。两处非关键源代码行号上界需文档精度修正，见末段。

## Root package：17 项现有测试与构建边界

- 读取 [root-package.md](../root-package.md)、[first raw log](root-package-baseline.first.log)、[exit](root-package-baseline.first.exit.txt) 和 [receipt](root-package-baseline.receipt.json)。命令一致：`node scripts/run-bun-test-shard.mjs --timeout 30000 tests/build-meta.test.ts tests/package-boundaries.test.ts`；原日志为 **17 pass / 123 expect / 0 fail / 0 skip / Completed**，exit 文件和 JSON 均为 0。
- `tests/package-boundaries.test.ts` 的 16 个测试只读取 source/manifests、创建内存变体并调用声明/版本/发布命令构造验证函数。`publishCommands("next")` 只构造参数；所导入 publisher 的实际入口位于 `invokedAsMain` guard 下。本复核没有执行或请求 npm、publisher、release smoke。
- `tests/build-meta.test.ts:10–64` 的唯一测试先创建 owned 临时目录，`:22–25` 用 `copyFile` 逐字复制生产 `scripts/build-meta.ts`，`:28–35` 写入 fake TUI 和 stale fixture chunk，`:39–44` 执行临时副本，`:49–61` 测试两个生成 launcher 的参数与 executable bits，最后清理。`scripts/build-meta.ts:19–24` 以**自身脚本所在目录**定位 `dist`，所以该测试清理的是 fixture 的 `dist`，不是共享 checkout 的输出。它不能证明完整真实 CLI、干净安装或发布成功。
- 独立将两份现有测试及生产 `scripts/build-meta.ts` 当前字节与冻结 Git 对象比较，3/3 相同；不是新增测试。报告对临时复制构建的表述准确。
- `package.json:42` 的 `test:watch` 确实直接指向 `bun test --timeout 30000 --watch tests packages`；`CODESHELL.md:140–146` 要求 unit shard 使用隔离 runner；`scripts/bun-test-completion.mjs:117–118` 拒绝 watch。能确认入口差异，不能从这些静态行推断真实 watch 已泄漏状态或造成用户影响。报告把它保留为未定优先级的**静态候选**，没有纳入正式 finding，口径合适。

## Skills/Agents：部分通过属于失败 shard

- 读取 [skills-agents.md](../skills-agents.md)、[first raw log](skills-metadata-first.log)、[exit](skills-metadata-first.exit)、[validation](skills-validation.json)、原 fixture 和两份 manifest/receipt。
- 原日志完整显示 **13 pass / 1 fail / 1 error / 26 expect；14 reported tests across 4 files**，末尾是 `Bun test process failed (1)`，没有 `Completed Bun shard`。exit 文件与 validation 都是 1，报告没有将其改称成功。
- 13 个通过来自 3 份既有纯 parser/serializer 文件：`tests/agent-definition.test.ts` 5、Core serializer 2、Core skills frontmatter 6。直接 `yaml` import 位于自有 fixture 第 5 行；日志的首个未处理错误正是该包从 `docs/.../evidence` 无法解析。5 个新声明 test 均未进入测试体，不能称 scanner/snapshot/Skill tool/CRLF/嵌入 delimiter 已动态复现。
- 独立读取 `skills-source-manifest.json` 的 26 条来源，对当前 SHA256、记录 SHA256 与冻结 `git show` 原字节 SHA256 三方比较，**26/26 一致**。再对 `skills-artifact-receipt.json` 的 8 个 artifact 重算字节数及 SHA256，**8/8 一致**。这只证明来源/制品一致性，不补充缺失的行为执行。
- `frontmatter.ts:9,18–24` 的 closing regex 不约束完整 delimiter 行，`agent-definition.ts:90–93` 的 opening/closing regex 使用 LF 字面量；registry `:43–64` 会对解析异常记录 warning 并跳过。静态预测有源码基础；当前两候选明确 **SKIP**，没有独立正常触发动态证据，仍须和正式 finding 分开。暂定 P3 仅是候选标签。
- 没有从旧 cold-continuation issue、缓存失效约定、required fields 或 serializer 的 LF 输出扩出新缺陷，也没有恢复旧失败实验。

## 已核对的关键原字节哈希

| Artifact（相对此 evidence 目录） | bytes | SHA256 |
|---|---:|---|
| `../root-package.md` | 2847 | `6133ea2d1da96928a496ccb96dfb115da3b9df32abf37f95b9dca2d684b7cf62` |
| `root-package-baseline.first.log` | 2111 | `99efe288598ad3bec7e15cc5b5b8ffceb6b0ae29bdbdc5650b644be6dc38b4a6` |
| `root-package-baseline.first.exit.txt` | 2 | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` |
| `root-package-baseline.receipt.json` | 546 | `88014767c63ca88625e5469595735a02d170328bfeca432ce553d2bec94be5e8` |
| `../skills-agents.md` | 8923 | `2669698bec8304b433a35ace85763d9bb91618411d3cec980e7d9276bf6c4675` |
| `skills-metadata-first.log` | 1820 | `24b5fb12a5099f15a8e0127f01235c593ae71bf1a0139e139111dbf8d95fca09` |
| `skills-metadata-first.exit` | 2 | `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865` |
| `skills-validation.json` | 1739 | `5e64cbf0e9448a3b12e49053489a8b14041319781864e2f51836f71caa580a90` |
| `skills-metadata.test.ts` | 6380 | `6218e8b6e3fc91eb2fa8732ff50a36df7a1841b31522e48f59991359932a7c4a` |

这些哈希对应本次只读复核时的版本。若报告仅修正文档引用，应更新其 artifact receipt；原失败 fixture 和 raw log 不应改变。

## 文档精度小项

`skills-agents.md:9` 引用 `tool-system/builtin/skill.ts:135–165`，实际文件止于 154；`:11` 引用 `agent-definition-registry.ts:104–132`，实际文件止于 124。引用起点存在，当前候选结论和执行计数不依赖越界行，但建议作者收窄到实际存在且支持陈述的范围。已发给根协调者；本复核不编辑作者报告、不改测试。除这两个引用上界，没有发现会改变零确认结论、首跑身份或成功/失败分类的报告实质问题。

## 最终稿只读补核 — 2026-10-17 05:20:56 UTC

上文的报告哈希表及“两处引用上界待修正”描述的是**作者修订前的首次交叉复核快照**，不是当前最终稿状态。作者补充查重材料并刷新 receipt 后，本复核再次只读确认：

- 当前 `skills-agents.md:9,11` 已收紧为 `skill.ts:135–154` 和 `agent-definition-registry.ts:104–124`，均在实际 EOF 内；此前两项文档精度意见已解决。
- 最终查重口径为 **850 文件 = 338 JSON + 512 Markdown**，包括新补入的根 review Markdown 与七个 `docs/refactor/_archive` 文件；当前报告与 corpus 计数一致。补充没有把两项静态 SKIP 候选升为正式 finding。
- 对刷新后的 `skills-artifact-receipt.json` 再独立重算 8 个 artifact 的字节数与 SHA256，**8/8 一致**。当前报告为 **9203 bytes / SHA256 `efff8f799481911e0b3c3b8ac3c0a4686411f55336f97abeb4d64b2c8dd22ec4`**，取代上表中的旧报告身份。
- 首次失败 fixture、原始 log、exit 和 validation 的哈希与上表一致；**13 pass / 26 expect 仍属于 exit 1 的整体失败 shard**，自有 5 cases 未执行。Root 17 项现有测试和临时复制构建的证据分类不变。

本次补核新增测试、构建、native、网络执行均为 **0**；没有重跑、修复 fixture 或修改作者文档。仅追加本 note，交叉复核的最终结论仍是 0 新确认问题。
