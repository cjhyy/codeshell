# Review target：普通参数与 scope 静态审查

本范围 **0 formal / 0 candidate / 1 old-related，0 产品或测试尝试**。完整阅读新增 [review-target](../../packages/coding/src/review/review-target.ts:1) 406行及其 [测试声明](../../packages/coding/src/review/review-target.test.ts:1) 280行，并核相邻 prompt 与普通 TUI 调用，没有建立新的独立普通输入违约；补录1个旧registry家族在新review消费者中的静态关联，没有为凑数运行 baseline controls。产品未修改。

父任务报告分支 `codex/audit/review-targets-round26-20261017`、冻结提交 `6d61f57ade1ef1b9fdc4d33020652007d995e7a7`。本作者遵守零 Git 调用，只保存读取时与收尾时 filesystem SHA，10 pins 均保持相同；**没有声称独立验证 Git blob 或 HEAD**。[source manifest](evidence/target-source-manifest.json) 将父报告 freeze 与实际 filesystem pin 明确分开，供 Root 独立冻结核验。CODESHELL 已全文读取，字节未变。

普通入口是 [TUI /review](../../packages/tui/src/cli/commands/builtin/git-commands.ts:132)：usage 声明一个 file 及 json/dimensions/scope；handler 将 registry 整理后的 arg 交 parseReviewArguments，options.target 交 collectReviewTarget(ctx.cwd)，再把相同 dimensions/json/label 与完整 content.length 交 builder。空内容与 collection/argument 错误明确给 status，不直接当成干净 review；异步 collection 后检查取消信号。这里仅核普通数据传递，没有调用 Git、query guard、client 或模型。[Desktop 邻接消费者](../../packages/desktop/src/main/review-service.ts:190) 使用独立收集或 snapshot 的 content 调 builder，并声明自己的 draft budget；它没有调用这个新 target collector。

| 静态范围 | 合同与实际反证 |
| --- | --- |
| [参数解析42–158](../../packages/coding/src/review/review-target.ts:42) | 默认 all；scope 互斥；一个可引用/转义路径；`--` 后允许 dash-prefixed path；json/维度重复、未知或缺值参数会明确报错。当前86行已把 perf 映射为 performance，TUI137行 usage 使用 performance；测试38–58声明相同映射、引用路径和显式 scope。parser 自身与声明一致；上游 registry 仍有下述旧参数保真家族，单文件 parser 测试不能证明整条输入链保真。 |
| [scope收集161–244](../../packages/coding/src/review/review-target.ts:161) | working all 比较 HEAD 并加入 untracked，staged 不加入 untracked，unstaged 加入 untracked；base 明确用 merge-base，commit 明确 show；unborn all 汇合 cached/untracked 路径后读取最终 worktree。测试83–178分别声明这些普通合同，未将声明当执行通过。 |
| 有界完整性与表示 | numstat binary/NUL 检查、name-only列表、严格 UTF8 decode、added-file行尾元数据、file/diff字节与文件数限制都以可见错误收束；这是“完整有界 patch 或明确失败”的设计，不能把明示拒绝大文件/二进制当成新问题。Git、文件系统、特定 OS 与身份/安全 race 均未实验验证。 |
| [相邻 prompt](../../packages/coding/src/review/review-prompt.ts:68) | 当前 TUI 把已完整收集的 content.length 作为 maxChars，避免再次套旧12000字符边界；builder动态 fence、标签JSON quoting及截断披露均是源码事实。没有从 prompt 文案推断模型已正确审查，也未恢复旧 fence/UTF16 实验。 |

**TARGET-R26-R1 → 旧 CLI-R4-01，只记 source-only old-related。** [App注册](../../packages/tui/src/ui/App.tsx:124) 把 gitCommands 交实际 CommandRegistry；[dispatch133–141](../../packages/tui/src/cli/commands/registry.ts:132) 对整个输入先 `split(/\s+/)` 再将参数 `join(" ")`，才 `cmd.execute(arg, ctx)`。普通 `/review "src/a  b.ts"` 的两个内部空格因此在 quote-aware parser 之前被压成一个；新 parser 的 quote 分支本来会保留内部空格。这里仅推导参数文字，未调用 dispatch/parser/collect、未创建同名文件或证明实际错选了文件。路径不存在可显式报错；另一单空格路径存在且也在scope内时可能选择它，均仅静态条件影响。

[补充去重](evidence/target-registry-history.json) 从相同2509文件再查：command-spacing782命中保留20上下文，registry-split4命中全留。实际 [round4父报告](../audit-2026-10-17-round4/root.md:21) 已把相同 registry133–135 的 `/image "a  b.png"` 参数压缩列为CLI-R4-01；[旧validation第4个run](../audit-2026-10-17-round4/validation.json) 明确其首次fixture在产品导入前失败（0pass/1fail/1error/无Completed）。旧项仍是候选，整组保持SKIP，不能因为现在有新的review参数消费者就升级确认。本条只保存新的实际consumer trace，不新增bug/candidate、不恢复旧fixture。HL-01是Link精确路径的首尾trim，见补充父段；它与内部空白压缩原则不同，但本例已有更直接的CLI-R4-01父项，不借HL-01再包装新问题。

依赖边界尤其重要：review-target.ts 运行时导入 Node child_process、fs/fs-promises、path、util、Core extension 与 review-prompt，顶部建立 promisified execFile。**parseReviewArguments 与真实 collector 共用此模块，不能轻率当成零依赖纯叶子导入。** 既有 review-target.test.ts 的 beforeEach 会创建临时仓库并调用真实 Git；按测试名称选择 parser 也不能默认跳过这些 hooks。本轮没有 import、构造、调用、mock、fixture、VM/AST/eval、真实 Git/FS/PTY/native、网络、模型或 auth/permission/custody/identity/security 实验。相关安全/文件身份 guards 只按源码 inventory 阅读，没有验证其 authority。

[本轮全历史去重](evidence/target-dedup.json) 遍历 docs/bugs 下2509份 MD/JSON（1241MD/1268JSON），递归搜索426811 string leaves/609678 scalar leaves，0解析错，含嵌套 archive/_archive，排除 round26。读取时 round25 的56文件另列分区，保留其父任务集成时点；不能把其中旧 pass 变成本轮验证。target精确命中4个，均为 round25 两份集成元数据中的实际路径项，不是 target 系统审查或执行证据。prompt-prior109/ordinary-target151命中分别最多保留80上下文；关键词和选段不证明语义穷尽。

[实际历史父记录](evidence/target-history-selected.json) 保留 round19 完整报告、正式 finding 与两个 related 对象。`REVIEWPROMPT-R19-01` 是旧 TUI perf提示/parseDimensions 不一致；新 target parser 已显式支持别名，旧导出 parseDimensions 的独立行为不能再冒充新 TUI 路径错误。R19-R1/R2-03 固定 fence 与 R19-R2/DESKTOP-R12-01 UTF16 slice 只作为旧机制排除，不新增 related，也没有重跑旧 suite、Markdown/model/Unicode 或失败方向。源码状态观察不修改旧报告，也不称其修复经过本轮测试。

阅读覆盖为10 pins：6全文、4选段，产品/合同1140行及 CODESHELL217行；四个 review源/测试975行与公开index5行全文，TUI127–195、Desktop190–235、registry119–147和App114–129选段。全文件 hash 只固定字节，不把大调用方或 transitive imports 认领为全文。原 [临时负提案副本](evidence/target-prep/proposal.json) 8文件由 [copy receipt](evidence/target-prep-copy-receipt.json) 保留原字节，原 /tmp 不改；copy与hash复核不是新语义阅读或运行。

[findings](evidence/target-findings.json) 与 [candidates](evidence/target-candidates.json) 为空，[related](evidence/target-related.json) 仅上述1个旧家族关联；[validation](evidence/target-validation.json) 明确0运行。导航输出截断、一次 rg无匹配 exit1 和补充误猜 registry.test.ts 的 rg exit2边界见 [metadata notes](evidence/target-metadata-notes.json)，没有伪造完整工具输出、产品失败或恢复路径。[author receipt](evidence/target-artifact-receipt.json) 固定作者材料，另列 copied prep 归属；本作者只写本轮材料，0产品改动与0 Git命令/写入。负结果只限上述实际阅读及普通合同，不等于全仓或运行正确性证明。
