# Round27 Core/Link 小型静态补充

**0 formal / 0 candidate / 1 old-related**，0产品、测试、import、native、网络执行。本补充与 Root 的失败 compose 运行分别记账；没有借此恢复该动态方向。

全文读 [semver](../../packages/core/src/utils/semver.ts)、[memoize](../../packages/core/src/utils/memoize.ts)、[task sanitizer](../../packages/core/src/utils/task-sanitizer.ts)、[cwd normalize](../../packages/core/src/utils/cwd-normalize.ts)、[Link selection](../../packages/link/src/file-selection.ts) 及其 test 声明；另选读 Engine 的 noise 分支、plugin/skill cache resolver 和 linked-file source identity 消费点。精确范围与 frozen SHA 在 [manifest](evidence/root-frontier-source-manifest.json)，全文字节固定不意味着周围调用链也全文审完。

`memoize` 同时检查 `get` 和 `has`，所以 cached `undefined` 有明确反证；同步 fn 抛出发生在 `cache.set` 前。可缓存 rejected Promise 是泛型 API 的可能使用方式，但本次选读的两个 resolver/调用点不足以证明新的 Promise 拒绝问题，且旧 rejected-promise 原因已有历史记录，因此不凑候选。`semver` 只委托库，未测试库语义。cwd 两函数用明确 catch fallback；没有真实 filesystem/工作区场景证据支持新缺陷。sanitizer 是显式输入噪音启发式，Engine 根据 `isNoise` 返回提示；当前没有新具体合法任务被误判的证据，也不重开既有 ANSI/i18n/skills 失败方向。

**ROOT-R27-R1 → HL-01（旧关联）**：[Link resolver](../../packages/link/src/file-selection.ts:7) 的公共 `text()` 仍 trim path 后参与 params 与 source identity。这就是 [旧 host-link 报告](../audit-2026-10-17-round3/host-link.md:7) 已收录的精确 GitHub 文件路径首尾空格丢失原因，不是新bug。旧 HL-02 默认label的 UTF16 slice 也仍是旧原因。既有 test 名称写“exact paths”不能当本轮已执行通过。没有真实 provider、账户或 grant 操作。

[历史去重](evidence/root-frontier-dedup.json) 覆盖 docs/bugs 的1250 Markdown +1346 JSON、468104 string values /676635 scalar values，含档案、排除本轮目录，0解析错误。各查询总命中 memoize1145 /sanitizer87 /cwd50 /Link69 /trim13，contexts 各最多25；保存完整2596文件 SHA 库存，关键词搜索不等于语义穷尽。查询中显示的旧HL-01/HL-02与直接旧报告阅读足以排除本次重复。

[validation](evidence/root-frontier-validation.json) 的 runs 为空；[metadata notes](evidence/root-frontier-metadata-notes.json) 记录一次猜测旧报告路径失败，已按库存定位，不是产品失败或重跑。
