# 第十五批：Sources 文档输入与上下文摘要

冻结基线：`ae777b3fce6fc9986e69ceb62802f3bb3f6aa478`。本分区 **0 项正式 bug，1 项静态候选；0 次 Bun 执行**。首次前 metadata 位置检查发生断言失败，已保留并跳过文档 parser 动态方向。没有修支架、安装依赖、改用另一路径或执行替代解析。

## DOCINPUT-R15-C1：两字节前缀可能把普通 UTF-8 文本误判为二进制

状态：**静态候选，动态验证 SKIP，无严重级别**。位置：[parse.ts:397](../../packages/core/src/sources/documents/parse.ts:397)、[parse.ts:398](../../packages/core/src/sources/documents/parse.ts:398)。项目交付文档明确支持 UTF-8 文本，包含 [Markdown、CSV、JSON](../todo/workspace-upload-document-index-delivery.md:7)。普通用户上传的 `review.md` 可从 `PK review notes` 开始，`progress.csv` 可从 `%Progress,Task` 开始。这些例子均为纯可读文本，不需要 Office/PDF 解析器。

源码在通用文本解码之前，只比较起始 `PK` 或 `%P` 两个字节，满足就抛出 `Unsupported uploaded document format`。因此静态推导上述文字会进入拒绝分支，增加首行换行、改变大小写或换成其他普通前缀则不会满足该条件。该推导**尚未执行真实 parseDocument**，没有已观测的错误输出、成功对照或用户上传事实，不能作为本轮确认缺陷计数。预期是支持范围内的普通 UTF-8 文本可提取原文；真正不支持的二进制格式仍应拒绝。候选只涉及格式分类过宽，不涉及权限、原件修改、解析器隔离或安全绕过。

静态生产链：[parser-entry.ts:108](../../packages/core/src/sources/documents/parser-entry.ts:108) 把解码后的字节和 filename 交给 parseDocument；[index-store.ts:122](../../packages/core/src/sources/documents/index-store.ts:122) 等待 parser 结果才构建索引。本轮未启动入口、worker、完整 ReadSource 或 UI，因此不声称这些层已经实际返回错误。

查重：[完整收据](evidence/docinput-dedup.json) 覆盖本轮以外真实 `docs/`、`bugs/`（以及存在的 archive/_archive 路径）库存：**1,825 文件 = 1,102 Markdown + 723 JSON；281,762 个递归 JSON 叶子，0 解析错误**。对 parseDocument/Office、二进制前缀与普通文本、换行/phonetic、context-summary 分组检索。[prefix 最近匹配上下文](evidence/docinput-prefix-dedup-context.json) 保存了超长 JSON 叶子中实际命中位置附近文字，21 处匹配均为其他领域或覆盖描述，未找到同一文本前缀误判条目；这是关键词和人工核对的查重结论，不是全仓不存在重复问题的证明。

## 首次前失败与未执行边界

[首次 preflight 响应转录](evidence/docinput-preflight-skip.md) 记录 Python metadata 命令 exit 1 / AssertionError。命令仅检查源码文件和**猜测的根 node_modules package.json 路径**，在写出 preflight 收据和 fixture 之前失败。该合并断言没有给出哪个检查失败，也没有调用 Bun 或导入产品模块；所以不能证明实际 Bun workspace resolver、saxes/yauzl import 或产品依赖有问题。没有生成或执行聚焦 test 文件，**failed Bun shards = 0，successful Bun shards = 0**。

[导航响应转录](evidence/docinput-navigation-skip.md) 单独保留误猜 `docs/bugs` 目录和旧 worker receipt 名称的 metadata 错误，相关猜测均跳过。完整历史查重使用独立全仓文件库存，不把管道末端 exit 0 当成缺失路径已读的证据。

## 其他审查范围与去重排除

完整阅读 parse.ts、parser-entry.ts、context-summary.ts，以及相关 types、truncate-utf8、parse/context-summary 测试、resolve.ts、index-store.ts 的普通数据传播。旧 [S01/S02](../audit-2026-10-17/sources.md) 的 Office 关系路径和 namespace 前缀、以及 XLSX phonetic 注音候选均不重新登记或重跑。没有恢复旧 JSON summary repair、i18n 或其他失败方向。

context-summary 的静态链路核对了空绑定/过期 profile 返回空串、label/kind/status/scopes/high priority 字符串输出，以及 resolve 的优先级排序。输出列与项目摘要设计一致，未获得新的普通输入合同违例；没有通过伪造 label 注入、安全/权限实验或制造非法 Profile 来增加候选。既有测试只读，没有执行。parser-entry 的 stdin 字节/JSON/base64 到 result/error 包装只读核对；不验证网络探针、进程隔离、native 库、凭据或运行时环境。

没有产品修改，没有真实 Office/PDF 应用、parser worker、模型、网络、账户、用户文件、外部消息或 UI；没有 build、typecheck、lint、全 suite 或 E2E 的通过主张。[冻结源码清单](evidence/docinput-source-manifest.json) 保存 12 个实际已读文件的冻结 Git blob 与 SHA-256；hash 核对是 metadata，不是产品功能验证。
