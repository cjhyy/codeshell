# Provider reviewer 的只读交叉复核

冻结源码：`1b04838474bcd57212f80f791d0e268a00d347e3`。复核对象为最终 `root-metadata.md`、`tui.md`、首次失败转录/raw/exit、TUI validation 与 artifact receipt，以及对应选择性源码。没有增加、修复、重跑或替代执行测试；没有产品修改或 Git 写操作。

## Root 元数据方向

- 最新 root 报告保持 **0 确认**。`root-i18n-contract.test.ts` 是保存的计划 fixture；依赖字节回执在 checkout-local `packages/web/dist/index.js` 的 `Path.read_bytes()` 处失败，工具转录没有任何 Bun/JUnit 执行输出。因 collector 在 `subprocess.run` 之前失败，**guarded runner 零启动，不计 Bun shard 或 pass/fail/expect**。
- `root-i18n-preflight-failure.md` 已明确 collector 没有解析实际共享 package resolver。这仅证明本次元数据准备失败，不能证明真实运行时 import、共享依赖或发布产物缺陷。支持保留 SKIP，不修路径/依赖或补跑。
- `root-static-search-skip.md` 的 `zsh: no matches found` 是导航命令的工具响应转录，不是 Bun log，也不是主题产品缺陷。报告没有把它混入测试统计。
- 选择性复核 Desktop/Web `translate.ts`：callback 形式的 replace 保留普通 `$` 字符，unknown placeholder 和 fallback 的说明有源码支持；未执行的 fixture 不能外推字典一致性、全部调用方或语言切换正确。报告保持这条边界，没有宣称翻译测试通过。
- 根报告的主题、source 文档解析观察均标明静态或未覆盖，不从导航失败/缺产物构造新 bug。复核不代表对这些整片目录再次做了全文审查。

## TUI 方向

- `tui-diff-display.first.log` 实际启动 Bun，但模块导入找不到 `../../../../packages/.../DiffLine.js`：**0 pass / 1 fail / 1 error，无 expectations/completion**。exit JSON 为 1。report 与 validation 逐项吻合，两个 Diff 候选没有动态证据。
- 独立既有 baseline raw/exit 确认 **5 files / 27 pass / 264 expect / 0 fail / 0 skipped / Completed**。它检查 store、失败流撤销、slice anchor 和 memo，对 Diff 候选没有验证作用；报告没有将其当成 27 个新复现或全部终端覆盖。
- 选择性复核 `DiffLine.tsx:45`–54、100–111 与 `ToolCall.tsx:368`–402：`+const`/`-const` 无空白时按源码走 context，而不是增删样式；函数注释又有避免普通 `+x` 误判的意图。保留需要 hunk 上下文的 source-only 候选合理，没有要求盲目放宽全局正则。
- CJK pad 算例是静态计算：无 gutter、80 列、20 个宽字符，UTF-16 `.length` 计 22，补 58 空格后预期列宽 100。报告没有冒充成功 renderer/终端测量，P3/P2 确认均未晋升。
- 读取并按 bytes/SHA256 核验 TUI artifact receipt 的 **10 个文件，全部匹配**；最终两份报告里的所有本地 Markdown 链接都存在。新审查产物的存在/哈希不能替代失败方向的产品行为证据。

## 复核快照

以下为本次只读检查时的文件 SHA256；root 汇总后的最终 evidence-index 具有最终产物权威性。

| 文件 | SHA256 |
| --- | --- |
| `root-metadata.md` | `85293596049364a1b941e7e68be4b393f2a97e2d7bca14776ce34aecd01b2e75` |
| `root-i18n-preflight-failure.md` | `f4afdd347b1220fdb29d9a9cb3b6d6dddd4477b8bd0c5206b08bb3ff3732e7d4` |
| `root-static-search-skip.md` | `3364a4130c7ff70b2b38f36cfd4ac6e4af5e5e2cccaa9c0704953ec4af506ef1` |
| `tui.md` | `fa13450f37f50c6d6f1aff1c2389657805e67de0878a33d00e40162daa94fba1` |
| `tui-validation.json` | `da99ea10d1cf0bf3c6f5cd7ac62b711db36a6a48cb0ec4c9d74358dae1556729` |
| `tui-artifact-receipt.json` | `9505fa06773a0283052898442ee22b168a79e3998bd4128c481c0514c4ff3ca9` |

结论：支持 root 元数据 **0 确认、翻译准备方向 SKIP**；TUI **0 确认、2 候选、1 个独立绿色既有 baseline** 的当前口径。没有额外可晋升确认项，也没有通过新的执行补强已跳过的方向。
