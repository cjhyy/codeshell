# 独立只读复核：Core utils（第 14 批）

复核者：`/root/server_bytes_round14`。冻结基线 `badc2262a90966f6f903977b849adf1f22b55e9f`。读取 utils.md、候选/正式/validation/manifest/receipt、两份首次 raw/exit、两份自有 fixture 原文，以及 Slice/format/既有测试与 TUI wrap-text/output 接线。**没有运行产品、测试、失败 fixture、替代算法、UI、终端或 Git 写操作。**

结论：当前材料支持 **0 formal、2 静态候选、1 旧关联** 的保守分类，没有阻止整合的实质问题。

- Slice 首次 raw 字节数 497、SHA `d8cdd4fea84b2aec613adba982ac420f09737d3ab14e890ab0395fcfc8386409` 与 exit receipt 一致。Bun 因 `../../../../packages/core/src/utils/sliceAnsi.ts` 多退一层而加载失败，0 pass / 1 fail / 1 error，exit 1、没有 Completed。该结果没有加载目标 Slice 或测试体，两个候选的预期输出均只是源代码推演。
- format 首次 raw 字节数 649、SHA `c57d556a4b03d3bd5c2cacf98035bdf1c1093c4745d2062ea4c3e2a59b2ff416` 与 exit receipt 一致。6 pass / 6 expect / 0 fail / 0 skipped，存在完整 `Completed Bun shard: 6 tests, 0 skipped; 0 failures.`。既有测试只调用 formatDuration，覆盖 0、1、500、999、1000、1500ms，不支持其他 formatter、Intl formatter 行为或全仓结论。
- `utils-cache-format-controls.test.ts` 没有运行收据/日志，报告与 validation 明确 0 attempts，且仍包含错误相对 import。不得从其中断言提取新的实测结论；本次复核也没有执行或修复它。
- C1 源码的 display-column 头部与 code-unit `.slice`/visIdx 相悖；普通消费者的 stringWidth/start/end 接线确实存在。报告同时保留 header 对 wide-character fidelity 的限制，不把静态推演升级为已验证渲染缺陷。
- C2 的最后可见字符后 break 会跳过尾部基础 SGR reset，是与源码一致的候选推演；报告没有扩大为已发生全局样式泄漏。相关 Core 摘要 Unicode 切分仅记旧缺陷家族关联，不重复增加新 formal。
- 全历史库存 1088 MD + 680 JSON = 1768 文件、0 JSON parse errors。utils 的 260285 是全部 JSON 标量叶子；bytes 另报 185197 string leaves，口径不同，不能相加或互相当作错误。
- 当前最终 metadata 的 **18 artifact hashes** 与 **16 frozen Git blob hashes/current bytes** 全部核对相符；报告本地链接存在。作者已根据复核把“format/intl 基线”收窄为 formatDuration 六项，并只刷新 metadata 收据，没有新产品测试。

## 复核工具诊断转录（仅元数据）

第一次库存时 utils.md 尚未落盘；接着 cat 的首次工具响应为：

```text
cat: docs/audit-2026-10-17-round14/utils.md: No such file or directory
exit_code: 1
```

这是作者材料尚未就绪的可用性诊断；作者通知最终材料已保存后，重新库存确认文件存在，再阅读最终报告。未据此修复/重跑产品方向。

第一次元数据核对已成功验证 18 artifact hashes，随后检查器误用 `manifest["files"]`，实际 schema 为 `sources`，工具响应末尾是：

```text
manifest fields dict_keys(['frozenBase', 'sources'])
Traceback (most recent call last):
  File "<stdin>", line 10, in <module>
KeyError: 'files'
exit_code: 1
```

后续先读取 manifest 的实际 schema，再仅改元数据读取字段为 sources，验证全部 16 个冻结 Git blob 与当前字节一致；没有执行、修复或更换任何产品/失败 fixture 的验证。这两次元数据诊断不计为 Bun 或产品失败。
