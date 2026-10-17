# TUI Bidi 纯谓词与重排源码审查

冻结源码：`ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f`。本范围 **0 项正式缺陷、2 项候选、0 项旧缺陷关联**。首次 guarded shard 为 **7 pass / 21 expect / 0 fail / 0 skip**，全部为本批新增的源码提取谓词测试。未执行真正的 `reorderBidi` export、`bidi-js`、终端或平台门控。

## 覆盖与执行边界

完整读取 [bidi.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/bidi.ts:1)。静态读取 [output.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/output.ts:567) 的 grapheme/style/width/hyperlink 生产、重排调用和写 cell 消费链；该文件其余渲染分支并非完整动态覆盖。另读 [stringWidth.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/stringWidth.ts:1) 前 150 行、[render/README.md](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/README.md:1) 的内部接口说明和 TUI 包依赖声明。`bidi-js` 在 package/lock 中声明为 `^1.0.3` / `1.0.3`，未查询实际 resolver、导入该库或核验其安装实体。

`needsBidi()` 的平台/env 分支只做静态阅读，不执行、不修改 `process.platform` 或环境变量。没有 Windows/macOS/WSL/VS Code 真实行为证据。没有 Core、Ink、React、PTY、native app、terminal、网络或模型执行；没有沿用已失败的 `sliceAnsi` 或 i18n 动态方向。

[首次 fixture](evidence/bidi-predicate.test.ts) 从绝对路径读取 SHA 固定的冻结 `bidi.ts`，仅提取第 132–140 行 `hasRTLCharacters`，只移除函数签名的 `: string` 和 `: boolean`，regex/body 原样通过 `new Function` 编译。[提取记录](evidence/bidi-extraction.json) 保存原函数、编译函数及包装文本的 SHA。这个证据是 **compiled-from-frozen-source predicate**，不等同于实际模块 export 调用或完整 Bidi 算法执行。

## BIDI-R16-C1：快筛遗漏 Adlam 的强 RTL 字母

候选位置：[bidi.ts:132](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/bidi.ts:132)，静态消费者：[bidi.ts:63](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/bidi.ts:63)。模块注释给出的合同是将 logical order 转为 visual order，快筛却只列若干 BMP 范围。

实际提取谓词对两个正常 Unicode 字母 `U+1E900 U+1E901` 返回 `false`，同样的字符串加上 ` שלום` 后返回 `true`。希伯来语、阿拉伯语及带组合标记的普通文本为 `true`，Syriac/Thaana 为 `true`；ASCII、空串、中文和 emoji 为 `false`。[Unicode 官方 DerivedBidiClass](https://www.unicode.org/Public/UCD/latest/ucd/extracted/DerivedBidiClass.txt) 将 `U+1E900..U+1E943` 归为 `R`，所以这不是仅含 LTR 内容的输入。

由源码可推断：软件门控启用且整行只有这些漏检字母时，第 63–64 行会在库运算之前返回原数组。这是静态调用链推论；本批没有运行门控、库、完整 export 或实际终端，也未证明当前终端/字体支持 Adlam 的产品合同，故保留候选、不赋正式级别，不声称已观察到真实显示倒序。

## BIDI-R16-C2：重排对象后缺少可见的奇数级镜像处理

候选位置：[bidi.ts:67](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/bidi.ts:67) 至第 105 行。函数取 embedding levels 并反转整组 `ClusteredChar`，保持各对象的 `value` 原样返回；没有在此函数中按奇数 embedding level 为括号等选择镜像 glyph。[output.ts:805](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/output.ts:805) 将该 `value` 直接交给 `setCellAt`。

普通输入样例为带括号的希伯来文本 `(שלום)`。本批实际谓词可识别 Hebrew，但 **没有执行该样例的 embedding-level 计算或数组重排**。[Unicode UAX #9，§3.4/L4 与 §7](https://www.unicode.org/reports/tr9/) 将奇数解析级别的镜像 glyph 处理列入显示规则；只调整对象次序不体现该步骤。

本批只核对了当前函数及上述直接消费者，未核验最终字体/终端或其他下游是否承担镜像。因此这是 **静态候选**，不是已复现的错误括号输出；没有声称库调用自身有缺陷，也不把 Unicode 的字体显示要求直接当成所有终端的字符串替换要求。

## 对照与已排除猜测

初看工具返回的转义文本曾怀疑 regex 内含双反斜杠；在任何 Bun 运行之前，[metadata preflight](evidence/bidi-preflight.json) 核验实际字节，首段是 `[92,117,48,53,57,48]`，即一个反斜杠、`u`、`0590`，连续双反斜杠计数为 `0`。该猜测被否定，没有登记为问题，首次 fixture 的字节和 ASCII 控制也通过。

数组反转实现按对象搬移，静态上没有拆开 grapheme、width、styleId、hyperlink；level 数组同时反转，未发现这条对应关系的直接破坏。未动态运行完整算法，不能据此声明复杂 embedding、grapheme 内部级别、paragraph/line、mirroring、终端显示或性能均正确。

[历史查重](evidence/bidi-dedup.json) 覆盖 prior `docs/`、`bugs/` 的 **1,882 个 MD/JSON：1,119 MD、763 JSON、222,452 个 JSON string leaves、0 解析错误**，含 `archive` / `_archive`，排除本批。`module` 仅命中最初 source inventory 中的 `bidi.ts` 路径一次；mechanism/clustering 未命中。上下文上限每 pattern 80 条，计数不被该上限截断。这是关键词与结构化叶子的查重证据，不能证明全历史语义无重复。本批没有导航路径失败、Bun 失败或重跑。

## 首次验证与材料

首次命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round16/evidence/bidi-predicate.test.ts
```

combined stdout/stderr 与 exit 在检查前先写入 [raw log](evidence/bidi-predicate.first.raw.log) 和 [exit receipt](evidence/bidi-predicate.first.exit.json)。守护器给出 `Completed Bun shard: 7 tests, 0 skipped; 0 failures.`；没有任何第二次产品执行。[验证汇总](evidence/bidi-validation.json)、[findings](evidence/bidi-findings.json)、[candidates](evidence/bidi-candidates.json)、[source manifest](evidence/bidi-source-manifest.json)、[外部合同记录](evidence/bidi-external-contracts.json)、[材料 receipt](evidence/bidi-artifact-receipt.json) 分别记录计数、范围、来源和文件 SHA。
