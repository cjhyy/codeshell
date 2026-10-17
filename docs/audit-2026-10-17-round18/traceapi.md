# Web remote model trace API：普通参数与返回值

冻结源码：`65691923fa629970ac26dc04e35362a9c4ab57a8`。本方向 **0 项新增确认缺陷、0 项新增候选、0 项旧问题关联**。一组首次 guarded Bun 验证通过：**8 个聚焦测试、23 次断言、0 失败、0 跳过**。这只是下面明确列出的客户端适配器覆盖，不代表整个模型历史功能已验证。

## 审查范围与合同

- 实际运行叶模块 [`model-trace-api.ts`](../../packages/web/src/model-trace-api.ts:25) 中的 `createRemoteModelTraceApi`，通过注入的内存 `request(path)` 记录路径、返回测试自有对象。模块的 Core 引用全部是 type-only；没有导入 Core barrel/runtime，也没有 mock Core 或 i18n。
- 普通合同为四个 GET 资源的路径选择、可选查询参数编码及 requester 返回值透传：源码 [list/sessions](../../packages/web/src/model-trace-api.ts:48)、[get](../../packages/web/src/model-trace-api.ts:56)、[getConfig](../../packages/web/src/model-trace-api.ts:68)，类型选读 [普通过滤字段与分页返回类型](../../packages/core/src/model-traces/types.ts:97)，本地文档 [Reading](../../docs/model-observability.md:107)。
- 普通生产者只做静态选读：[`ModelTraceExplorer.tsx:267`](../../packages/web/src/components/ModelTraceExplorer.tsx:267) 传入 `limit`、`cursor`、字符串过滤值或 `undefined`；[`ModelTraceExplorer.tsx:313`](../../packages/web/src/components/ModelTraceExplorer.tsx:313) 组装 list 查询；[more](../../packages/web/src/components/ModelTraceExplorer.tsx:403) 继续传入 `nextCursor`。没有导入、渲染或运行该组件。
- 现有 [`model-trace-api.test.ts`](../../packages/web/src/model-trace-api.test.ts:4) 的普通部分仅供静态合同参照；首次读取输出也包含同文件后续排除片段，但未分析这些分支或执行该文件。现有文件包含本批排除的负向边界用例，故没有用整份现有测试充当基线。

## 首次验证结果

命令、首次 combined stdout/stderr 与退出回执分别保存在 [fixture](evidence/traceapi-normal.test.ts)、[原始输出](evidence/traceapi-normal.first.raw.log)、[退出回执](evidence/traceapi-normal.first.exit.json)。raw 与 exit 文件均先落盘，再读取结果；只有一次执行，没有失败后修复或替代验证。

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round18/evidence/traceapi-normal.test.ts
```

| 实际覆盖 | 观察结果与限度 |
| --- | --- |
| 省略查询、显式 `undefined` | `list`/`sessions` 四次调用落到两个无 `?` 的固定路径；fixture 第一项标题中的 “four ordinary route paths” 指四次调用，实际检查的 pathname 是这两个。 |
| 全部普通 list 字段 | `limit`、`cursor`、`search`、`traceId`、`sessionId`、`withoutSession`、`model`、`provider`、`purpose`、`callType`、`source`、`status`、`since`、`until` 经 URL 查询解码后与原值逐项相同；覆盖 Unicode、组合音标以外的普通 Unicode 字符、标点、`false` 与时间值 `0`。冻结 query 未被修改。 |
| sessions 筛选与继续分页 | `search: "🙂 café"` 包含组合音标；`withoutSession: true`、普通分类、limit 及 requester 自有 Unicode opaque cursor 均保留。适配器没有实施服务端筛选或生成 cursor。 |
| list 的 page 透传 | 自有冻结 page/items/item 的对象身份、total、nextCursor 保留；fixture item 只含所观察的几个字段，不能据此声称真实记录 schema 或 Host 数据完整性已验证。 |
| 明确空字符串 | `search`、`cursor`、`provider` 的空字符串保留为显式空参数，`undefined` 的 model 不出现。没有从此推导服务端如何解释空参数。 |
| get 的普通 ID | 本地编造的 `normal_record-1` 形成对应资源路径，并原样返回自有 detail/events；没有使用真实、外部或用户记录。detail 是用于透传观察的局部自有对象。 |
| getConfig | 固定 `/config` 路径与自有配置对象完整透传；没有读取或更新 Host 配置。 |
| 两个并发普通请求 | 两个内存 Promise 反序完成后，各自 query 与 page 仍对应原请求；没有网络、取消、重连或组件时序结论。 |

guard 的原始输出为 `8 pass / 0 fail / 23 expect() calls`，随后为 `Completed Bun shard: 8 tests, 0 skipped; 0 failures.`。这些全部是本批新增聚焦测试；没有运行现有测试、完整 suite、build、typecheck 或 lint。

## 历史去重与记录边界

[`traceapi-dedup.py`](evidence/traceapi-dedup.py) 按真实 `rg --files` 库存读取此前整个 `docs` 与 `bugs` 的 Markdown、递归解析 JSON 叶子，包含 archive/_archive，排除本批：**1,995 文件 = 1,148 Markdown + 847 JSON；253,680 string leaves / 353,952 scalar leaves；0 读取或解析错误**。完整 pattern、匹配计数及至多每 pattern 20 条上下文在 [`traceapi-dedup.json`](evidence/traceapi-dedup.json)。上下文上限没有限制计数。

5 条 exact-path/name 命中均为早期源码库存，或第十四批另一个 `packages/desktop/src/preload/model-trace-api.ts` 的 pin；没有发现此前记录的本方向普通编码/透传根因。其余两个索引 pattern 为 0 命中；关键词索引不等于全历史语义完备证明。正常结果不据此新增 “无 bug” 的全功能结论。

预检仅检查真实源文件、绝对 fixture import、冻结 Git 与当前字节，见 [`traceapi-preflight.json`](evidence/traceapi-preflight.json)；未猜测依赖路径、加载 resolver 或运行产品。源文件选读范围与 SHA 见 [`traceapi-source-manifest.json`](evidence/traceapi-source-manifest.json)，首次运行计数见 [`traceapi-validation.json`](evidence/traceapi-validation.json)。没有导航/依赖/fixture 失败，也没有恢复任何此前跳过的方向。

本批没有探测认证、撤销、外部 ID、scope 拒绝、访问控制或其他安全边界；没有真实 fetch、server、Hub 组件、Host/provider/model 请求、用户数据、原生进程或权限实验。没有验证 requester 本身、服务端筛选/分页、存储、真实记录与跨组件展示。只写本报告与 `evidence/traceapi-*`，产品代码、依赖和 dist 均未修改。
