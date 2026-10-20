# 只读交叉复核：Diagnostics

复核者：`model_catalog_round10`。冻结源：`6966dc0f98d21dbc2ecced6cdd6467d17b81bc39`。

结论：**同意保留 DIAG-R10-01 / P3**。未发现需要降级或修改的实质问题。没有新增、执行或重跑测试；只读报告、fixture、首次日志/退出码、生产源码和历史查重材料，仅写本复核文件。

## 契约与根因

- `packages/browser-devtools/README.md:43–44` 将 DOM traversal bounded 与记录/返回上限分别陈述；`docs/todo/browser-automation-library-reuse.md:81` 也单列 DOM 节点上限。`inspector.ts:132–134` 的独立 visited 预算和 `:168/:172` 的 queue cap 支持这里是遍历工作的边界，不止是返回数组长度。
- `inspector.ts:167/:171` 的 `Array.from(...)` 求值先于 for 循环执行，完整生成临时数组后才检查 queue cap。即使 root 已满足输出 limit，仍复制整个直接 children collection；shadow children 在 light queue 已满时也会先完整复制。这个根因与上限目标不符。
- 报告没有声称 queue、visited 或输出 nodes 本身超过上限。它准确限定为 collection 枚举和临时数组分配仍随宽子树大小增长，因此 P3 的有限资源工作量缺陷有依据。

## 夹具与证据界限

- 首次 fixture 通过实际 `createBrowserInspector` 和 VM 执行原 callback，fake page 没有自行重写 BFS。`countedCollection` 提供固定 length、有限普通 element 迭代序列；20,000 兄弟节点或 open-shadow root 子节点不需要畸形 DOM 语义。它不是完整 HTMLCollection，不具备 indexed/named access 或真实 DOM/live collection 行为，报告已明确承认。
- `Array.from` 在此有限迭代序列上的完全求值足以显示当前 cap 放置过晚。对生产 HTMLCollection 的推广属于源码推导，而非已执行真实浏览器；当前报告和 findings/validation 均做了这一区分。
- 两个观察均读 20,000 项但只输出 1 个 node、`truncated:true`；4-child 对照完整输出 root 与 children 且非 truncated。报告没有利用 VM 测试耗时来宣称真实页面延迟、内存峰值、8 秒超时、卡死或安全影响。
- Desktop `browser-inspector.ts:9–10` 与 `puppeteer-browser-driver.ts:624–631` 确有当前消费者接线；只读接线不证明整条 Desktop/真实浏览器工具链运行，报告亦未外推。

## 查重与材料核对

- 已读历史搜索结果及 round3 报告。`CDP-R3-03` 是在 `visibility:hidden` 祖先处提前剪枝导致可见后代丢失；本项是 eager collection materialization，触发、根因和影响不同。现有历史命中没有相同 eager children 枚举上限缺陷。
- 两个首次日志各为 5 pass、0 fail、0 skip，expect 分别 20、24；合计 10 pass / 44 expect，与 validation 一致，均有 guarded completion 和 exit 0。观察断言通过未被描述成产品修复。
- 13 个 manifest 文件的 frozen Git blob SHA、当前文件 SHA，以及 fixture/log/exit receipt SHA 均重新只读核对通过。未执行任何产品或测试代码。

必要修改：无。继续保留当前输出仍有界、真实 HTMLCollection 未运行、无实际浏览器性能测量等限制说明。
