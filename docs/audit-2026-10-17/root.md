# Coding / TUI / 其他模块续审

基线 `ab8b03f86ad38835939d4125b56bf4513cae7f15`。当前仅写审查材料，产品源码只读。问题编号使用 R2-xx，不与上一轮混淆。

## 确认问题

### R2-01 [P2] Claude 项目目录编码碰撞，使另一项目会话被标为当前项目

- 位置：`packages/coding/src/cc-orchestrator/session-discovery.ts:228-250`（目录仅依赖有损 encodeCwd，返回时直接填入调用者 cwd）；`:371-375`（同目录计数）；`session-history.ts:173-181`（读取同 bucket 的会话）。
- 触发：两个正常路径 `/workspace/foo-bar` 和 `/workspace/foo/bar` 的非字母数字字符都变为 `-`，编码后目录相同。两个 JSONL 文件都明确携带各自真实 cwd。
- 预期：项目 A 的列表/计数只含 A 的会话，或至少按文件记录的 cwd 保持真实归属。实际：A 的列表含 B 的 sessionId 和问题文字，同时将该条 cwd 错标为 A；A 的计数也包含 B，按这个错误上下文读取能得到 B 的正文。
- 影响：项目会话列表、打开历史和后续上下文定位不一致。没有执行外部 Claude、takeover 或真实用户会话，不声称已观察实际任务在错误目录写入。
- 生产接线：`related-session-discovery.ts:94` 使用该项目级函数；Desktop 的普通历史读 IPC 在 `main/index.ts:5864` 调用对应 history reader。全局 Pet 发现函数另有真实 cwd 过滤，不能把本条扩大为所有发现入口。
- 证据：`evidence/root-session-discovery.test.ts`，真实 reader + 自有临时 JSONL；两个碰撞路径与不碰撞正常对照。`root-session-discovery.log` 为 2 pass / 8 expect / 0 fail/skip / Completed，首次即保存原始日志。
- 查重：旧两轮主索引与 coding 分报告未找到同根因已确认项；当前源码已有全局发现的碰撞防御，但项目级消费者没有应用。

### R2-02 [P2] Codex 列表选新 rollout，打开历史却取旧 rollout

- 位置：`packages/coding/src/cc-orchestrator/codex-session-history.ts:195-210`，匹配到相同 threadId/cwd 的首个文件就 return；列表在 `codex-session-discovery.ts:46-50` 按 mtime 去重保留较新文件。
- 触发：恢复后的同一线程存在两个 rollout（源码注释明确支持此布局），新 rollout 的 mtime 比目录枚举首个匹配文件更新。
- 预期：列表、历史和 tail 定位使用同一个最新的线程文件。实际：列表标题来自新文件，打开历史却返回旧文件的消息。
- 影响：已恢复线程的较新对话不可见，用户在同一列表项看到旧历史。Desktop 的 `cc-room/transcript-subscriptions.ts:383` 同样用该定位器作为 tail 来源，但本轮只做静态接线核验，没有运行真实 tail/外部 Codex。
- 证据：`evidence/root-rollout-selection.test.ts`，真实异步列表+history reader，自有双文件及受控 mtime；先读取实际枚举顺序，再把首项设旧，不假定文件系统排序。单文件正常对照。原始 `root-rollout-selection.log`：2 pass / 6 expect / 0 fail/skip / Completed。
- 查重：旧主索引未找到同根因已确认项。旁路 changed-files reader 有类似首匹配逻辑，尚未单独执行，未将其算作另一动态发现。

### R2-03 [P3] Markdown 导出把工具正文里的代码围栏解析成导出结构

- 位置：`packages/tui/src/cli/commands/builtin/export-md.ts:130-134`，无条件用三反引号围住未经转义的工具结果；长结果 preview 与 reasoning 有相似结构，但本轮动态只验证短 tool_result。
- 触发：工具结果来自常见 Markdown 源码，正文包含独占一行的三反引号及其后的 `# 标题`。
- 预期：工具正文完整显示在一个代码块内。实际：内层围栏提前关闭导出代码块，正文的标题变成导出文档一级标题，后文被重新开块。
- 影响：`/export markdown` 的阅读结构与原工具结果不符；导出源文本仍存在，不属于正文持久丢失。
- 证据：`evidence/root-export-fence.test.ts` 使用真实 renderSessionMarkdown 和当前安装的 marked lexer，验证正文标题成为 heading、代码块拆成两块；无围栏正常对照保持一块。日志 `root-export-fence.log` 为 2 pass / 5 expect / 0 fail/skip / Completed。没有运行完整 TUI 或外部程序。
- 查重：旧主索引/CLI 分报告未找到同根因已确认项。

### R2-04 [P3] Claude transcript 的一个 null 记录中止整段健康历史

- 位置：`packages/coding/src/cc-orchestrator/session-history.ts:81-87`、`:106-113`；JSON.parse 成功后未验证非 null 对象就读取 `d.type`。
- 触发：本地 JSONL 包含健康 user 记录和一行合法 JSON 标量 `null`。预期与损坏 JSON 行一样隔离不识别的记录，保留健康消息；实际 snapshot parser 与逐行 tail parser 都抛 TypeError。
- 影响：`readRecentHistory` 在 `:181` 不捕获解析异常，打开该历史失败。Desktop follower 在 `cc-room/transcript-subscriptions.ts:294-308` 的 catch 会标为失败，但本轮没有运行真实 follower，不将静态接线当作端到端验证。
- 证据：`evidence/root-history-corruption.test.ts` 直接调用真实两个 parser；损坏 JSON 字符串正常对照会跳过且保留健康消息。日志 `root-history-corruption.log` 为 2 pass / 4 expect / 0 fail/skip / Completed。
- 条件：这是本地损坏/不符合对象 schema 的记录隔离问题；没有证据证明正常 Claude writer 会生成 null，也未接触真实用户 transcript。
- 查重：上一轮 root/desktop 报告和主 findings 索引未找到相同根因确认项。

### R2-05 [P3] 复制回复为纯文本时修改 fenced code 正文

- 位置：`packages/desktop/src/renderer/markdown/stripMarkdown.ts:13-14` 先移除围栏，随后 `:39-40` 对已经暴露的代码正文应用强调正则。文件顶部明确约定保留代码内容原样。
- 触发：普通 Python 围栏正文含 `if __name__ == "__main__":`、`a*b*c`、`"*literal*"`。预期仅去围栏；实际分别成为 `if name == "main":`、`abc`、`"literal"`。
- 影响：复制出的代码语义改变。原消息仍然保留；此项仅覆盖回复的“复制为纯文本”，不声称代码块独立复制按钮有问题。
- 生产接线：`packages/desktop/src/renderer/messages/AssistantMessageView.tsx:53` 将此函数结果交给复制 hook。
- 证据：`evidence/root-copy-code.test.ts` 调用真实转换函数，普通 prose 强调和简单代码块为正常对照。日志 `root-copy-code.log` 为 2 pass / 6 expect / 0 fail/skip / Completed；未操作实际剪贴板。
- 查重：上一轮 root/desktop 报告和主 findings 索引未找到相同根因确认项。

### R2-06 [P3] TUI 把代码围栏内的表格源码提取成真实表格

- 位置：`packages/tui/src/ui/components/MessageContent.tsx:164-175` 逐行检测表格，没有保留代码围栏状态；`:316` 在 Markdown parser 前运行该提取器。
- 触发：回复用 md 代码围栏展示三行 Markdown 表格源码。预期管道符和分隔行作为代码保留；实际渲染为 flex table，原始管道符/分隔行消失，并把闭合围栏单独显示为三个反引号。
- 影响：用户看到的示例结构与代码原文不符，难以照着抄写；原消息数据仍在，不属于持久数据丢失。
- 证据：`evidence/root-tui-tables.test.ts` 第一项直接挂载真实 MessageContent 与本仓 renderer，用 PassThrough 捕获输出；普通 fenced code 中的管道符和真实表格为正常对照。原始 `root-tui-tables.log` 为 3 pass / 10 expect / 0 fail/skip / Completed（也包含 R2-07）。未启动真实终端或模型；logger 等包依赖读取安装的 dist，组件和 renderer 从源码导入。
- 语义依据：代码围栏正文作为 literal text 保留，见 [CommonMark §4.5](https://spec.commonmark.org/0.31.2/#fenced-code-blocks)。
- 查重：上一轮主 findings 和 root/TUI 报告未见同根因确认项。

### R2-07 [P3] TUI 表格单元格含转义管道符时，后列正文从显示中消失

- 位置：`packages/tui/src/ui/components/MessageContent.tsx:177-181` 直接按每个 `|` split；表格 renderer `:297-303` 按 header 列数渲染 data cell。
- 触发：两列表格第一格包含合法的 `left \| right`，第二格是 `expected-tail`。预期两格分别显示 `left | right` 和 `expected-tail`；实际被切成三格，显示前两格 `left` 加一个反斜杠、`right`，最后一格完全不显示。原始日志的 JSON 表示会将这个反斜杠转义成两个。
- 影响：普通表格回复在显示层静默丢失后列内容并错列，原始消息没有改变；未宣称导出/复制或其他 host renderer 同样受影响。
- 证据：上述 `root-tui-tables.test.ts` 第三项挂载真实组件，原始日志保存输入与扁平显示文本；同组真实普通表格为正常对照。只执行 isolated renderer，没有外部会话/UI自动化。
- 语义依据：[GFM §4.10 Example 200](https://github.github.com/gfm/#example-200) 明确单元格内的转义管道符是正文的一部分；本组件采用的 marked-terminal 支持 GFM，但该前置手工提取器绕过 parser。
- 查重：上一轮主 findings 和 root/TUI 报告未见同根因确认项。与 R2-06 的围栏状态错误分别记录，修复边界不同。

### R2-08 [P3] Codex apply_patch 重命名的变更文件列表遗漏新路径

- 位置：`packages/coding/src/cc-orchestrator/external-agent-changes.ts:117-125`（关键正则在 `:121`）仅匹配 Update/Add/Delete File，不匹配 `*** Move to:`。
- 触发：普通 freeform apply_patch 更新 `src/old.ts` 并 Move to `src/new.ts`。预期变更归属至少包含新文件，保留旧路径也合理；实际只返回旧路径。
- 影响：DriveAgent 的 changedFiles/摘要无法展示这次修改后的实际文件；只审归属元数据，没有执行实际 patch、外部 Codex 或 UI 文件跳转。
- 生产接线：`packages/coding/src/tools/drive-agent.ts:784` 读取后交由 `normalizeChangedFiles` 规范化；该函数只 resolve/relative/去重，不补遗漏的 destination。本仓 `tools/apply-patch/index.ts:36` 明确列出 Move to 重命名语法，parser.ts:12、30 也识别该语法。
- 证据：`evidence/root-changed-file-paths.test.ts` 第一项调用真实 extractor，Update/Add/Delete 普通补丁为正常对照。原始 log 为 3 pass / 6 expect / 0 fail/skip / Completed；其中第三项仅验证下方候选，不计额外确认问题。
- 查重：上一轮主 findings 与 root 报告未见同根因确认项；同 rollout 首匹配定位线索归属 R2-02，未另计。

### R2-09 [P2] Review diff 把正常修改正文当文件头，丢行并改错路径

- 位置：`packages/desktop/src/renderer/diff/parseUnifiedDiff.ts:62-72` 在已进入 hunk 后仍优先处理文件头；`:105-112` 又排除所有以三个加/减号开头的正文行。
- 触发：文本文件从 `-- before` 改成 `++ after`，例如普通 SQL 注释或运算符示例。实际 Git 产生 `--- before` / `+++ after` 的合法删除/新增行。
- 预期/实际：应保持 sample.txt 路径并显示一行删除和一行新增；真实 parser 把 oldPath 改成 before、newPath 改成 after，hunk 中没有任何 add/del，后续 context 行号也错位。
- 影响：Review 展示遗漏真正改动，文件标题、计数和后续行定位错误。打开文件/添加评论会使用错误 AST 路径是静态接线结论，未执行 UI 点击或真实评论。
- 证据：`evidence/root-unified-diff.test.ts` 第一项在自有临时 Git repo 中生成真实 diff（关闭 hooks/签名、无网络），调用生产 parser；最后一项普通 ASCII 改动为正常对照。首次 `root-unified-diff.log` 为 4 pass / 13 expect / 0 fail/skip / Completed，也包含 R2-10/11。
- 生产接线：`UnifiedDiffViewer.tsx:82` 对 Review service 和 turn snapshot 的 diff 使用该 parser，`:261` / `:346` 使用路径显示/打开。仅 parser 动态验证，没有运行 Electron。
- 查重：旧主 findings / root / Desktop 报告和 10-12 remaining 审查有限查重未发现同根因确认项；旧 Git argv 问题不同。

### R2-10 [P3] Review 中纯重命名文件丢失两个路径

- 位置：`packages/desktop/src/renderer/diff/parseUnifiedDiff.ts:48-57` 忽略 diff --git 的文件名；`:74-76` 遇 rename from 仅设 status，不保存路径，也无 rename to 分支。
- 触发：只改名、内容完全不变的 staged 文件；Git 输出 diff --git、similarity 100%、rename from/to，没有 ---/+++。
- 预期/实际：应保留 old.txt → new.txt 的身份；真实 parser 返回 `{oldPath:null,newPath:null,status:"renamed",hunks:[]}`。
- 影响：Review 把正常重命名显示为未知文件，onlyPath 过滤不能匹配，文件打开动作缺乏正确目标。后续 UI 行为为源码接线推论，未实际点击。
- 证据：`root-unified-diff.test.ts` 第二项自有 Git repo 实际生成 staged rename diff；原始收据同 R2-09，源码 parser 动态验证。边界仅纯 rename，不扩大为所有 rename-with-content。
- 语义依据：文件身份包含在 diff --git 和 extended rename headers，见 [Git diff-format](https://git-scm.com/docs/diff-format#_generating_patch_text_with_p)。
- 查重：与 R2-08 的外部 CLI changedFiles 元数据不同，此处影响正常 Desktop Review AST；旧报告未找到同根因确认项。

### R2-11 [P2] Review 的 Git quoted 路径未经解码，中文文件无法正确定位

- 位置：`packages/desktop/src/renderer/diff/parseUnifiedDiff.ts:63-70` 将带引号/八进制转义的原文交给 `:143-145`；stripPrefix 只识别无引号 a/、b/。
- 触发：默认 core.quotePath=true，已跟踪 `中文.txt` 有普通内容修改。Git 的 +++ 路径为带双引号和 UTF-8 八进制转义的 b/ 路径。
- 预期/实际：应得到文件相对路径 `中文.txt`；真实 parser 保留整段双引号/b前缀/八进制转义。禁用 quotePath 的同一文件正常对照可解析。
- 影响：标题错误，onlyPath=真实文件名时过滤为空，构造的文件打开/评论路径不对应实际文件。后两项为 renderer 源码接线推论，未操作实际文件打开或评论。
- 生产接线：ReviewService 使用 desktop-services 的 getGitDiffForReview / range / commit diff，未对 core.quotePath 设置 false，也未在返回前解码；UnifiedDiffViewer 直接使用 parser。引号/控制字符即便 quotePath=false 仍需处理，未另行动态扩展该边界。
- 证据：`root-unified-diff.test.ts` 第三项，自有临时 Git repo 的真实 quoted diff + 真实 parser；原始收据同 R2-09。没有读取用户 Git 状态或修改产品代码。
- 语义依据：Git 的路径引号/八进制转义及默认 true 见 [git-config core.quotePath](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath)，patch 同样采用该形式见 [diff-format](https://git-scm.com/docs/diff-format#_generating_patch_text_with_p)。
- 查重：旧报告 file-search 的 quoted path 缺陷对应另一读取器，当前 file-search 已变更；本项是不同且仍未解码的 Review parser，不能把旧问题直接算当前复现。

## 候选与只读缺口（不计确认）

- apply_patch 的 JSON function_call.arguments 被直接当原始补丁扫描，观察到提取路径含 `\\n@@...` 的整段后缀。`root-changed-file-paths.test.ts` 第三项实际确认这段数据变换；但尚未证明当前生产 Codex 在 apply_patch 上使用此 JSON 参数形状，因此不计正式发现。
- `packages/core/src/engine/query.ts` 的 generator consumer break 不取消后台 loop 为静态线索；本轮 `rg` 未找到生产 import/export 消费者，也未运行，不将未使用入口按真实产品行为计 bug。
- `UnifiedDiffViewer.tsx:236-245` 的 capFiles 为保证至少显示首文件，可能将单个大文件的全部行带入渲染，使 2000 行保护阈值无法约束此情形；源码明确有至少首文件的设计选择，尚未验证真实性能/产品取舍，不计确认。供后续独立 Review 性能方向核查。
- 摘要 JSON 两个候选：`utils/json.ts:11` 的 greedy fence 匹配跨过后续 fenced example；`memory-orchestrator.ts:370` 的尾逗号修复可能修改字符串内的 `,}`。首次独立 `root-summary-json.test.ts` / `.log` 为 **1 pass / 2 fail / 6 expect，退出1，无Completed**。支架错误地将 baseDir 当作 `listSessionMemories` 的首个 limit 参数（实际签名为 limit,baseDir），使正常对照也读到空数组；所以不能据此断言生产摘要未保存或正文损坏，两个候选均不计确认。第一项直接 extractJSON 确实给出合并文本，但服务影响仍未可靠验证。原测试标题中的 R2-12/13 是临时标签，未分配为正式发现；按用户要求保留首跑并跳过，不修参数、不重跑/改道验证。
- 两条辅助源码搜索使用了不存在的旧路径（renderer/components/messages、coding/tool-system/builtin）或未匹配 shell glob，退出非零。它们不是动态 fixture，未作任何产品问题证据；正确路径由独立文件清单确定。没有重跑失败动态实验。

## 已读范围与验证边界

当前从外部会话 transcript 的读取/转换、TUI export/render/Unicode/交互纯逻辑开始。所有动态测试经 guarded runner，首次保存完整 stdout/stderr；遇到无法正常验证的项目按用户指令记录并跳过，不把支架失败计作产品 bug。

既有相关 baseline：项目/Claude/Codex history/discovery/related 及 Markdown strip、search highlight，7 files / 72 pass / 186 expect / 0 fail/skip / Completed，原始日志 `evidence/root-parser-baseline.log`。它们未覆盖上述碰撞、同线程双 rollout 与导出围栏场景。

补充相邻既有 baseline `root-adjacent-baseline.log`：实际仅运行 external-agent-changes.test.ts，8 pass / 8 expect / 0 fail/skip / Completed。命令中误写的 MessageContent.test.tsx 未被 Bun 选择，不能声称已运行 TUI 既有 suite；发现该覆盖缺口后未重新执行该命令。TUI 的动态证据来自本轮独立真实组件 fixtures。

本报告的10个完整成功 shard 共 **100 pass / 252 expect / 0 fail / 0 skipped**。失败的摘要候选组独立保存，不加入干净门禁数字。真实 renderer、真实本地 Git、source reader 及 pure helper 的覆盖层级分别描述，不能据此声称完整应用或真实外部 CLI 验收。
