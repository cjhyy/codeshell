# ApplyPatch 纯解析与行内容审查

冻结提交：`d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a`。本节新增 1 项 P3，0 个待定候选。产品代码未修改。

## PATCH-R12-01 [P3] 首个 Update chunk 省略可选 `@@` 时丢失显式空白 context

- 位置：[parser.ts:149](../../packages/coding/src/tools/apply-patch/parser.ts:149)，`parseOneHunk` 在调用 chunk parser 前用 `trim() === ""` 跳过行。
- 正常输入契约：parser 的 V4A grammar 第 14 行允许空格前缀的 context；第 19 行明确允许首个 Update chunk 省略 `@@`。公开工具说明 [index.ts:37](../../packages/coding/src/tools/apply-patch/index.ts:37) 将 anchor 标为可选，第 53–54 行要求提供足够 context 以唯一定位修改。
- 触发：首个 chunk 的行序列为 `[" ", "-same", "+changed"]`。其中 `" "` 是合法的 context marker，加上空字符串行内容；`"  \t"` 同样是合法、内容为 `" \t"` 的 context 行。普通文件可以包含这些空白行。
- 预期：前一种输入应得到 `oldLines: ["", "same"]`、`newLines: ["", "changed"]`。实际 parser 将首行当成 chunk 间分隔符丢弃，得到 `["same"]` 和 `["changed"]`；连续的空白 context 也一并丢失。
- 实际验证：直接调用产品 `parsePatch`，再将结果交给产品纯函数 `seekSequence`。对于内存行列表 `["same", "separator", "", "same"]`，丢失 context 的 AST 匹配位置为 `0`；加入显式 `@@` 的对照保留 context，匹配位置为 `2`。这是匹配范围变化的实际执行证据。
- 消费路径：工具 wrapper [index.ts:72](../../packages/coding/src/tools/apply-patch/index.ts:72) 使用 lenient parser，然后把原始 AST 传给 applier；[applier.ts:217](../../packages/coding/src/tools/apply-patch/applier.ts:217) 直接以 `chunk.oldLines` 搜索，并在第 236 行记录替换区间。该消费路径仅做静态追踪；本轮没有执行 applier、ApplyPatch 工具或文件写入，因而不声称实际文件已经被改错。
- 对照：显式 `@@` 保留相同的空白 context；省略 `@@` 时非空白的首 context 正常保留；chunk 内部的空白 context 正常保留；Add 内容中的空格、tab、Unicode 和标点保持原样。
- 查重：`docs/` 与 `bugs/` 全部历史 1,658 个 Markdown 与 parsed JSON（仅排除本轮目录），0 个解码/解析失败。[去重收据](evidence/patch-dedup.json) 保留文件哈希和匹配片段。首次按 audit/review/archive 路径筛选的 1,168 个文件子集也已原样保留；随后仅补充去重元数据到完整范围，见 [范围说明](evidence/patch-dedup-note.md)。旧 May 30 [parser finding](../archive/review-2026-05-30/findings.json) 的 `$[117]` 是“无 marker 的空行被接受”，对应当前 `parseUpdateChunk` 第 245–250 行；本项是合法、已有 marker 的空白 context 在进入该函数前被丢弃，触发条件、分支及所需修复不同。
- 证据：[纯函数 fixture](evidence/patch-leading-context.test.ts)、[首次原始日志](evidence/patch-leading-context.first.log)、[首次退出收据](evidence/patch-leading-context.first.exit.json)。8 项测试通过，31 次断言，0 fail/skip；测试刻画冻结源码的错误输出与对照行为，不是修复后的回归测试。
- 建议：chunk 间分隔符的跳过逻辑应区分真正的分隔空行和已带空格 marker 的 context，确保省略 `@@` 与显式 `@@` 在内容表示上等价。

## 覆盖与限制

完整阅读 parser、types、seek-sequence、EOL helper 和工具 wrapper；阅读 applier 前 260 行（普通内容规划与匹配消费段）及现有 `tests/apply-patch.test.ts`。只执行本节新建的 parser/matcher 纯函数 fixture。未执行现有混合测试，因为它们会调用 applier 和改写临时文件。本节不把未执行的既有测试计入通过数。

CRLF patch 输入没有被记作缺陷：本地 parser grammar 明确写 LF，applier 注释也约定模型 patch 为 LF，本轮没有建立额外的 CRLF patch 兼容契约。匹配器的宽松空白/Unicode规则是已有明示行为，不另报。历史 rename 权限、rollback 字节、cache invalidation 和无 marker 空行项只做排重；未重验。没有执行工具、Git/native 子进程、路径策略/权限/身份验证/资源 custody 实验、真实模型/网络请求或用户数据操作，也没有构建依赖或 dist。

每个首次原始日志及退出码均先保存后查看；本方向没有失败 shard，没有重跑或替代验证。源文件覆盖与哈希见 [source manifest](evidence/patch-source-manifest.json)，范围、计数与限制见 [validation](evidence/patch-validation.json)，本节材料哈希见 [artifact receipt](evidence/patch-artifact-receipt.json)。
