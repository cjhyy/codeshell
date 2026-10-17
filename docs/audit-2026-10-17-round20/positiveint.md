# 第20批 — TUI 正整数选项 leaf

冻结源码：`d40dd06987a2e0c20c377e243cf5c4e4b549c9ec`。本方向 **0 新正式问题、0 新候选、0 新关联**，产品代码未修改。

实际执行 [parse-int-option.ts](../../packages/tui/src/cli/parse-int-option.ts#L1) 与其真实 Commander 依赖；没有依赖路径猜测或 mock。完整读取这个 24 行 leaf、29 行原测试，静态 selected 读取 [main.ts](../../packages/tui/src/cli/main.ts#L54) 的选项定义/action（1–155 行），以及 [runs.ts](../../packages/tui/src/cli/commands/runs.ts#L101) 的 import 引用、90–120/265–290 行。后两个模块没有导入或执行。

## 首跑证据

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/tui/src/cli/parse-int-option.test.ts docs/audit-2026-10-17-round20/evidence/positiveint-focused.test.ts
```

[首次原始合并日志](evidence/positiveint-first.raw.log) 与 [exit 收据](evidence/positiveint-first.exit.json) 在检查前保存，exit 0，guard 完成：**13 pass、36 expect、0 fail/skip**。其中原有 5 测试/6 断言，新 [focused](evidence/positiveint-focused.test.ts) 8 测试/30 断言。只有一次产品测试尝试，没有重跑。

新增控制覆盖 trim 空白、十进制前导零、全零/空值/空白、正号/小数/指数/十六进制/二进制/分隔符拒绝、非 ASCII 数字形状拒绝、真实错误类名称和保留原始值转义/label，以及 `positiveIntOption` 两个闭包的独立 label。最后一例只让实际 leaf 返回 `Number.MAX_SAFE_INTEGER` 和 `2147483648`，未调用计时器、分配对应大小的列表、执行等待或增加模型轮次。该结果不验证下游上限策略。

## 普通调用链和历史去重

`main.ts:71,101,131` 将实际 wrapper 用于 `--max-turns`、`--background-wait-ms`、session `--limit`；`runs.ts:101,276` 用于 run/event `--limit`，selected action 只是静态参数传递与 `.slice(-limit)` 证据。没有执行 Commander `program.parse`、CLI 格式化错误、进程退出、run/session store、模型或真实 timer。

[全历史扫描](evidence/positiveint-dedup.json) 排除本批，包含 **1,176 Markdown + 933 JSON = 2,109 文件**，递归 JSON 值有 **267,491 string leaves / 373,239 scalar leaves**，0 JSON parse errors。精确 leaf/export 模式 16 条匹配全部保留；广义精度/旧 parseInt 模式 1,040 条匹配仅保存前 100 个上下文，每段最多 1,200 字符。匹配只是导航，不证明语义穷尽。库存描述本次冻结工作树读取时点，不保证后来 main 文档不变。

[Round15 cli.md](../audit-2026-10-17-round15/cli.md#L7) 全文直接复核：原有 5 个 leaf 测试已经跑过，旧 unvalidated parseInt/NaN/trailing garbage 机制已经记录。第21行已明确大于 JS exact-integer 范围的输入缺少普通 producer/limit contract；本批没有恢复该探测或自造 `Number.isSafeInteger` 要求，也不重复记候选。详见 [去重决定](evidence/positiveint-dedup-decisions.json)。

旧失败 CLI data 方向继续跳过；只执行这个独立 leaf 的现有与新增测试。没有完整 CLI、REPL、native、terminal、Git 产品操作、真实账户/用户文件、网络或全量构建/typecheck/lint/suite。精确 source pins/read ranges 见 [源码清单](evidence/positiveint-source-manifest.json)，计数与范围见 [验证收据](evidence/positiveint-validation.json)。
