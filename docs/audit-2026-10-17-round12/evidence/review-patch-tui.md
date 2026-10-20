# 第十二批 ApplyPatch 只读交叉复核（TUI 审查者）

结论：支持 **PATCH-R12-01 / P3**，0 个候选。只读复核，没有新增、运行或重跑测试，没有修改 patch 报告或产品。

- 合同充分：冻结 parser.ts:14 允许空格 marker + text，:19 明确允许首个 Update chunk 缺省 `@@`。wrapper index.ts:37 标注 optional anchor，:53–54 要求唯一定位 context。fixture 使用带 marker 的合法空白 context，并非靠畸形补丁触发。
- 根因与差分一致：parseOneHunk:149–152 在进入 parseUpdateChunk 前用 trim 跳过 `" "` / `"  \t"`。显式 `@@` 会先通过外层循环，再由 chunk body 保留该 context。fixture 真实调用 parsePatch 对比 AST；再真实调用 seekSequence，将同一内存 lines 上的匹配位置从保留 context 的 2 变为丢 context 的 0。
- 控制合理：普通非空首 context、显式 `@@`、内部空白 context、Add 的字面 Unicode/空白/标点，分别约束 parser 分支。未执行 applier，报告明确将文件替换消费路径限于静态追踪；没有把纯 matcher 结果扩大成实际文件已改错。
- 首次证据：原始日志为 **8 pass / 31 expect / 0 fail / 0 skip**，完整 guarded runner 结束标记存在；exitCode=0。独立只读核对 log SHA 与 1,240 bytes、fixture SHA 均与首次 exit receipt 一致。没有重复执行产品验证。
- 源 pin：source-manifest 的 8 个路径全部匹配指定冻结提交的 Git blob SHA，当前 bytes 也与冻结一致。Manifest 说明 applier 仅前 260 行 source-only、既有混合测试未运行，范围准确。
- 去重：完整 dedup 记录 1,658 个 docs/bugs MD/parsed JSON、278 hits、0 errors，初始 1,168 文件子集另存并明确补充范围。独立读取 May 30 findings.json `$[117]`，旧项为无 marker blank 在 parseUpdateChunk 被接纳；本项是合法有 marker 的首 context 在外层被丢弃，触发与分支不同。未发现重复根因。
- artifact receipt：全部列明材料 bytes/SHA 独立核对通过。该检查仅验证材料完整性，不属于新测试数。

不增加发现、不提升严重性。不对 CRLF、权限、路径策略、rollback、实际 ApplyPatch 写入、Engine/模型或全仓库覆盖作结论。
