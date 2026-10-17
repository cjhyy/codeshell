# Desktop 纯显示 helpers 审查（第 12 批）

冻结源码：`d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a`。本分支仅写审查文档与证据，未改产品。

新增 **1 项确认 P3**、**1 个仅静态候选**；另记录 **1 个旧 R2-10 缺陷族的剩余边界**，不另计独立新 bug。两个首次 guarded shard 均完整成功，合计 **32 pass / 80 expect / 0 fail / 0 skip**。其中 focused 9 / 41，既有纯 helper 基线 23 / 39。测试包含错误现象断言，通过不表示产品修复。

## DESKTOP-R12-01 [P3] 工具卡摘要截断拆开 Unicode 代理对

- 位置：[tool-cards/utils.ts:13](../../packages/desktop/src/renderer/tool-cards/utils.ts#L13)。`truncate` 用 UTF-16 code-unit 下标 `max - 1` 截断后附省略号，未避开代理对中点。
- 普通入口：FileToolCard 直接从 `parsedArgs(message).file_path/path` 取字符串并在 [FileToolCard.tsx:53](../../packages/desktop/src/renderer/tool-cards/FileToolCard.tsx#L53) 以 70 截断；[GenericToolCard.tsx:122](../../packages/desktop/src/renderer/tool-cards/GenericToolCard.tsx#L122) 的参数摘要及 AgentToolCard description 使用 80；[BashToolCard.tsx:40](../../packages/desktop/src/renderer/tool-cards/BashToolCard.tsx#L40) 的命令摘要使用 90。本次测试均使用这些真实正上限，没有构造负数或零限额。
- 触发：合法输入 `x.repeat(max - 2) + "😀tail"` 长于摘要上限，保留末尾恰好是 emoji 的高代理项。对 70 上限，它也是长度小于普通单文件名限制的相对路径字符串；Generic 参数和 Bash 命令文本没有路径长度约束。
- 预期契约：摘要可省略后半段，但应保留合法 Unicode 文本；短 Unicode、保留完整 emoji 的边界、ASCII、BMP 中文对照均保持合法文本。
- 实际：生产 helper 对 70、80、90 三种限额分别返回末尾 `0xd83d + …`，`isWellFormed()=false`；同一字符串经标准 UTF-8 编码/解码后变成 `�…`。输入 `isWellFormed()=true`。
- 影响与边界：工具卡摘要可能显示损坏字符，影响路径/命令/任务摘要可读性。完整参数、原始路径与正文未被这个 helper 改写，不推断实际工具执行错误。实际运行的是生产纯函数和 TextEncoder/TextDecoder；UI 消费来自上述源码核对，未挂载 React/Electron，也没有观察真实平台 glyph。
- 证据：[首次 fixture](evidence/desktop-display-contracts.test.ts) 的三个限额观测与独立正常对照；[raw log](evidence/desktop-display-contracts.first.log)、[exit](evidence/desktop-display-contracts.first.exit.txt)。只运行一次。
- 查重：全历史 docs/bugs Markdown 与 parsed JSON 叶子搜索见 [dedup](evidence/desktop-dedup.json)。CHD02 是 Chat attachment 标签转换，HL-02 是 Host GitHub file selection 默认标签；类别相同，但它们都不调用或修复本 Desktop `truncate` 实现。本次未找到该生产路径/消费实现的旧同项；这是有界关键词上下文查重，不声称语义穷尽证明。
- 修复方向：按 code point 或在边界退让一个高代理项，保留现有省略号与正上限语义。

## DESKTOP-R12-C1：Write 工具卡把字符串长度标为字节

- 位置：[FileToolCard.tsx:55](../../packages/desktop/src/renderer/tool-cards/FileToolCard.tsx#L55) 只要 variant 为 write，就将 `content.length` 后附 `B`。
- 普通 Unicode 内容下，JS code-unit 长度和 UTF-8 字节数不同，例如 `中文` 是 2 个 code units、UTF-8 6 bytes。纯 ASCII 两者一致。
- 证据等级：只读源码和标准字符串语义推导；未挂载工具卡，也未执行 Write 或文件写入生产链。因此留为静态候选，未计确认，也没有单独动态测试。
- 查重：扩展全历史 `FileToolCard` / 写入字节数关键词，仅见库存或相关计划/验证记录，没有找到同项。脚本正则扩展时的首次 metadata 错误另存，未隐瞒为首次成功。

## DESKTOP-R12-R1：旧 R2-10 缺陷族的 header-only 剩余边界

这不是独立新 finding。旧 [R2-10](../audit-2026-10-17/root.md) 指出 parser 忽略 `diff --git` 文件身份，纯 rename 因缺少 `---/+++` 返回双 null。当前源码已补 `rename from/to` 分支，纯 rename 的旧触发已修；但 [parseUnifiedDiff.ts:48](../../packages/desktop/src/renderer/diff/parseUnifiedDiff.ts#L48) 仍只初始化双 null，没有读 header。

- 实际纯函数观测：mode-only (`old mode 100644` → `new mode 100755`)、空文件 added/deleted、普通 binary notice 都没有文本 `---/+++` 或 rename header，真实 parser 保留 status，却返回 `oldPath=null,newPath=null,hunks=[]`。普通文本 hunk 对照路径和行号完整。
- 正常格式依据：[Git diff-format](https://git-scm.com/docs/diff-format) 规定 patch 的 `diff --git` header 自带路径，扩展 header 包含 mode 与增删标记。只读核对 [Git 上游 diff.c](https://raw.githubusercontent.com/git/git/master/diff.c) 中 header/must_show_header/binary 输出分支，说明这些是普通 producer 可产生的无文本 hunk 形态。外部来源与边界见 [receipt](evidence/desktop-external-sources.json)。未运行安装的 Git，也不把字符串 fixture 称作真实 Git capture。
- 生产链静态核对：[desktop-services.ts:599](../../packages/desktop/src/main/desktop-services.ts#L599) 为 Review 全仓 diff 调用普通 `git diff --no-color --unified=3`；range 与 selected commit 分支也返回普通 patch。ReviewService 默认使用该 helper，[UnifiedDiffViewer.tsx:82](../../packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx#L82) 直接 parse。
- 下游影响是源码推导：[viewer:181](../../packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx#L181) 的真实 onlyPath 会滤掉这种文件；不筛选时 [title:261](../../packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx#L261) 落到 unknownFile，打开动作依赖该 title。fixture 直接按同一过滤表达式验证 mode-only 的实际 parser 结果无法匹配 `run.sh`；未调用 UI、IPC、Git 或打开文件。未要求显示 binary 内容，只讨论文件身份保留。
- 证据是 focused shard 前四项，共享原始日志，不另加测试计数。与旧 R2-10 因果行重叠，按旧缺陷族剩余边界记录，不重复增加新 bug 数量。

## 基线、排除与首次失败处理

既有 pure metadata 基线只运行 `keyboardShortcutHints.test.ts`、`tool-cards/utils.test.ts`、`diff/reviewScope.test.ts`，23 pass / 39 expect。平台标签 darwin/win32/linux/undefined、argsLive 优先/回放/非法 JSON、Bash stderr sticky 分类和保留文本、Review staged/unstaged/turn 筛选均通过。这不支持整个 Desktop、跨平台 UI 或实际快捷键处理的完整性结论。

未运行现有 parseUnifiedDiff.test.ts，因为前三项会创建临时 Git 仓库并启动真实 Git；只读其用例后，为本次 scope 使用纯字符串 fixture。旧 TUI Diff import 失败没有恢复。旧 R2-09 正文/header 混淆和 R2-11 quoted 路径缺陷已查重排除，没有重跑旧实验；单大文件渲染保护已有历史候选且本次没有 UI/性能验证，未再计。

`truncate(max<=0)`、`formatDuration(NaN/Infinity)`、parsedArgs JSON 数组等仅能以额外坏输入构造，未建立普通 producer 路径，未据此增加 bug。basename 对斜线结尾/Windows 分隔符、prettyJson 合法/非法 JSON、formatDuration 普通非负值有 focused 控制。Bash classifier 与 Core 当前副本逻辑静态一致。

产品 guarded 首次实验无失败或重试。审查元数据参考有两个不存在的猜测路径；扩大查重正则时有一次编译错误，后续只修 metadata 并重新生成记录。工具首次响应的明确转录见 [metadata notes](evidence/desktop-metadata-notes.md)，这些不计为产品失败 shard。所有产品 raw combined stdout/stderr 与 exit 都先保存再查看；没有通过修支架重跑掩盖失败。

## 可核对材料

[validation](evidence/desktop-validation.json)、[findings](evidence/desktop-findings.json)、[candidates](evidence/desktop-candidates.json)、[related](evidence/desktop-related.json)、[source manifest](evidence/desktop-source-manifest.json)、[artifact receipt](evidence/desktop-artifact-receipt.json)、[metadata assembler](evidence/desktop-assemble.py)。assembler 只重建材料索引，不运行测试。

没有产品/Git写、shared build/dist/deps 修改、完整 lint/typecheck/suite、模型/网络业务调用、UI/Electron/native/PTY、真实用户数据、权限/security/custody实验。对外只读官方文档用于格式契约；不能据本批推断完整端到端或跨平台结果。
