# Round 18 只读复核：Web remote trace API 普通适配器

结论：接受 `traceapi.md` 的 **0 formal / 0 candidate / 0 related** 与首次 **8 focused tests / 23 expect / 0 fail / 0 skipped** 结果。无需修改报告或夹具；本次复核没有新增产品 runtime、测试、Git 写操作或旧失败方向恢复。冻结源码核对使用了只读 `git show`。

先以真实 `rg --files` 库存定位 traceapi 材料，再按 artifact/exit receipt 指向读取被忽略的 raw 日志，没有猜测日志后缀或路径，没有元数据导航失败。完整读 report、validation、source/artifact receipt、preflight、dedup 脚本与 JSON、owned fixture 和 first raw/exit；产品叶子、类型合同及消费者与此前本 worker 独立静态阅读的真实源码一致。仅再次选读现有 `model-trace-api.test.ts:1–42` 普通合同，未执行整份含负向边界的现有测试，也未把之前显示的排除片段算作实际验证。

- 原始输出为 `8 pass / 0 fail / 23 expect() calls`，guard 为 `Completed Bun shard: 8 tests, 0 skipped; 0 failures.`；exitCode 0，guard 命令与 fixture 一致。raw SHA-256 为 `6505f896fe066d81697e2e9a58800b18aa918064943951f2980568b03434b3e2`。先保存后检查是首回执所记录的采集顺序，本复核没有重跑验证。
- Fixture 的实际动态调用只使用真实 `createRemoteModelTraceApi` 与注入的内存 requester，检查 list/sessions URL 参数、普通自有 get ID、固定 config 路径、自有返回值身份及两个内存 Promise 反序完成。绝对导入仅指向 Web 叶子，Core 引用为 type-only；没有实际 fetch、Host/storage/provider、认证/scope 拒绝实验或组件挂载。
- 第一项标题 “four ordinary route paths” 实际为四次调用到两个 pathname，报告和 validation 已明确披露；保留原始测试与 raw 没有修改标题重跑。局部 page/item/detail/event 对象只支撑透传/身份观察，报告明确不将它们当作完整真实 schema、服务端过滤/分页或 Host 完整性验证。Unicode、组合音标、空字符串、`false`、`0` 等范围与 fixture 实际值相符。
- 9 个 source pins 的当前字节、冻结 Git blob、SHA 和 bytes 全部一致；范围字段区分 full leaf、选读消费者、声明文件与仅 byte-pin 的 runner 实现。11 个 worker artifact 的 bytes/SHA 全部匹配；18 个报告本地链接存在，附行号均在真实文件范围内。没有给不存在文件生成 pin。
- 全历史去重覆盖 1,995 文件 = 1,148 MD + 847 JSON，253,680 string leaves / 353,952 scalar leaves，0 读取/解析错误。与独立 presentation 全文件 rglob 去重的文件及叶子总量一致；worker 脚本递归 JSON 含归档排本批。5 个 exact 命中是旧库存或 Desktop preload pin，两个普通编码/透传模式为 0；20 个上下文上限独立于实际匹配计数。报告没有把关键词结果当语义完备证明。

source-manifest 对最初文档/package 行数端点的元数据调整已有说明，不涉及产品重跑。通过结果只支持普通客户端适配器的明确范围，不证明 requester 本身、完整模型历史功能、跨组件显示或此前跳过方向已经验证。
