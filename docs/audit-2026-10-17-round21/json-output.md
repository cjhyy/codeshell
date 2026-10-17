# 第21批 — TUI JSON 输出渲染器

冻结源码：`615e4e4dd3a61b1ad132ab4f3683985a0d582386`。本方向 **0 新正式问题、0 新候选、0 新关联**；只记录，产品未修改。

完整读取 [renderer.ts](../../packages/tui/src/cli/output/renderer.ts#L1) 的163行及 [现有混合测试](../../packages/tui/src/cli/output/renderer.test.ts#L1) 的111行。实际执行 `JsonRenderer`、`JsonlRenderer`、`StreamJsonRenderer` 及 `createRenderer` 的三个 JSON 分支。TextRenderer 与 compactSummary 只静态读取，现有测试组含 Text 调用，因此整组未执行。

## 首跑证据

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round21/evidence/jsonoutput-focused.test.ts
```

[focused fixture](evidence/jsonoutput-focused.test.ts)、[首次合并原始日志](evidence/jsonoutput-first.raw.log) 和 [exit 收据](evidence/jsonoutput-first.exit.json)：raw/exit 先保存后查看，exit0、guard Completed，**16 pass / 52 expect / 0 fail / 0 skipped**，全部新增 focused 控制，一次尝试、无重跑。通过只证明列出的输出行为，不代表整个 headless host 已验证。

真实 renderer 模块绝对路径导入；真实 `chalk` 保留解析。仅 Text 使用的 `@cjhyy/code-shell-core/internal` 三个 export 和 [ui/truncate.ts](../../packages/tui/src/ui/truncate.ts#L1) 的 truncate 以精确 preimport stub 替换：被调用就计数并抛错；所有用例计数为0。没有导入真实 Core barrel、stringWidth、i18n、TUI Diff 或恢复任何旧失败方向。[前置检查](evidence/jsonoutput-preflight.json) 核验真实 source/Git bytes 和 fixture，不猜 node_modules 路径。

`process.stdout.write` 只在隔离测试子进程的同步动作内捕获，并于 finally 还原。JSON 控制包括完成前不输出、非空最终正文覆盖中间 delta、无 delta 的空完成、Unicode/普通 sessionId/turnCount、忽略非 text 帧、字符串引号/换行转义及非 completed reason。JSONL 与 stream-json 分别验证顺序、一事件一行、子 agentId/outputCursor 和终态 completionKind 原样保留、普通 final envelope、空 final 不借用先前 delta、事件对象不被修改；另对照两个别名输出字节相同。自有事件形状是输入，不是实际 Engine/provider/子代理或 CLI 链执行。

## 普通合同与去重

[run.ts](../../packages/tui/src/cli/commands/run.ts#L230) 逐 invocation 创建 renderer，client stream 的 envelope.event 传给 onEvent；onComplete 实际只收到 `{ sessionId, turnCount }`。这支持本批普通 final metadata 控制，不存在本批可达的 type/text/reason/result 自造碰撞输入。输出模式见 [main.ts](../../packages/tui/src/cli/main.ts#L70) 与 [headless 文档](../architecture/09-tui.md#L94)。这些 selected caller/document 只静态审查，没有调用 CLI、transport、run 或进程退出。

[全历史扫描](evidence/jsonoutput-dedup.json) 排除本批，含 **1,189 Markdown + 980 JSON = 2,169 文件**，递归值 **288,528 string leaves / 404,370 scalar leaves**，0 JSON parse errors。三个模式分别有133/488/148条 Markdown 行或值叶匹配，每组只保留前100上下文，每段最多1,200字符；匹配不是语义穷尽。库存描述冻结工作树读取时点，不保证后来 main 文档不变。[去重决定](evidence/jsonoutput-dedup-decisions.json) 明确：旧 [A12](../audit-2026-10-16/root.md#L99) 的 child delta + 空 final fallback 已确认，本批不重现或重记；2026-05-30 backlog_verdicts 的 JSON renderer reuse 第107项为 false_positive，当前一次 run 一个实例，没有普通复用 producer，不恢复此疑似问题。

静态还看到 [Core 类型](../../packages/core/src/types.ts#L652) 和 [run-finalize](../../packages/core/src/engine/run-finalize.ts#L396) 支持可选 completionKind，[protocol server](../../packages/core/src/protocol/server.ts#L1851) 将它交给 RunResult，而 CLI final meta 没有转交此字段。JSONL/stream-json 的原始终态帧会保留它，已做实际 class passthrough 控制；没有发现 CLI final envelope 承诺完整 RunResult 的明确合同，也没运行普通 headless async/goal 触发，故这一静态字段差异作为边界记录，不升级候选或缺陷。

Read 的字节/UTF16、旧 JSON-summary、FileToolCard、sliceAnsi、TUI Diff、i18n 均排除。没有模型、真实账户/用户资料、网络、native、PTY、真实 timer、权限/安全/custody、产品 Git、构建/typecheck/lint/全量测试。源码精确 hash/selected ranges 见 [源码清单](evidence/jsonoutput-source-manifest.json)，计数见 [验证收据](evidence/jsonoutput-validation.json)。导航截断、缺失目录/猜测文件和源码范围元数据校正记录在 [metadata notes](evidence/jsonoutput-metadata-notes.json)，没有造成产品动态失败，也没有触发产品重跑。
