# CodeShell 第十五批审查

冻结源码：`ae777b3fce6fc9986e69ceb62802f3bb3f6aa478`。本批覆盖文档输入解析、配置迁移/来源解析、注入缓存/steer 队列/inline image 语法，以及 CLI 普通整数和上下文参数。**0 项新增确认缺陷，4 项新候选，1 项旧候选关联。** 全仓持续审查仍在进行，本入口不表示所有内容已覆盖；没有修改产品。

| 候选 | 已获得证据 | 尚缺证据 |
| --- | --- | --- |
| [DOCINPUT-R15-C1](documents.md) | 静态两字节 `PK` / `%P` 分类与支持普通 UTF-8 文本的合同 | parser 动态验证已 SKIP；0 次 Bun 执行 |
| [MIG-R15-C1](migration.md) | 真实纯 parser 对 `.git/` 和 shorthand `.git` 的边界返回值及正常对照 | 这些边界形态的当前支持合同/普通生产者，未 clone/install |
| [STEER-R15-C1](injection.md) | 真实队列 helpers 加手工对应静态默认 id 表达式，产生重复 id 并一并撤回 | 未执行 Engine 默认分支，未建立普通 host 省略 id 的调用 |
| [IMAGE-R15-C1](injection.md) | 真实 parser 接受手造逆序但数量相等的标签；正常/非法语法控制 | 未建立普通 encoder/传输生产者，没有真实图片解码或用户故障 |

上述候选不定严重级别。[机器可读候选](candidates.json) 保留实际输出、静态推导和限制。[正式 findings](findings.json) 为空；[旧 C-SET-02 关联](related.json) 只查重排除，没有重新验证。旧 WEB-R8-02 的其他任务源码修复另见 [基线更新](baseline-refresh.md) 和 [source 状态](addressed-sources.json)，不计入本批新发现或旧候选关联。

5 组 **首次 guarded Bun shards** 均完整结束：**55 pass / 136 expect / 0 fail / 0 skip**，其中 33 个既有测试和 22 个聚焦观察/对照。CLI 9 个既有测试包含 8 个真实 helper 测试及 1 个源代码接线断言，不能视为已运行 REPL/Commander。测试通过证明这些观察/对照成立，不表示候选已修复或完整系统通过。原始 combined stdout/stderr 与退出收据均先保存再查看，未重跑产品；明细见 [validation](validation.json) 和 [CLI 专项](cli.md)。

Documents 的首次前检查在**猜测的根依赖 package.json 位置断言**失败，文档 parser 动态方向随即跳过。该检查没有调用 Bun resolver 或产品 import，因此 **0 failed Bun shards，0 parser Bun attempts**，不能推断实际依赖有问题。其余导航、可选 Node metadata 和 root schema 查询错误有明确首次响应转录；均与产品首跑分开，未用于恢复已跳过方向。

各专项全历史查重均覆盖本批以外 docs/bugs 的 **1,102 Markdown + 723 JSON = 1,825 文件**，含存在的 archive/_archive。Root/Injection 统计 **200,618 JSON 字符串叶子**；Documents/Migration 统计 **281,762 全部 JSON 标量叶子**，不是同一口径。没有 JSON 解析错误；关键词与有限上下文人工核对不构成语义穷尽证明。

四份专项只读交叉复核：[Documents](evidence/review-documents.md)、[CLI](evidence/review-cli.md)、[Migration](evidence/review-migration.md)、[Injection](evidence/review-injection.md)。冻结源码与当前/主分支字节分列在 [source manifest](source-manifest.json)；其中 worker 的 66 次源码核对与 41 次 artifact 核对见 [worker integrity](worker-integrity.json)。整体 source manifest 为 67 个去重路径（含另行记录的旧 Mobile 源码变化），明确跳过已记录的不存在 `packages/core/src/engine.ts` 引用；整文件哈希不表示整文件或所有依赖已审阅。[Evidence index](evidence-index.json) 记录本批文件 bytes/SHA-256（自身除外），raw 原样保留。

最终 [汇总只读复核](evidence/review-aggregate.md) 无阻断意见；[Root evidence 复核](evidence/root-qc.md) 记录 source pin 补全等元数据校正。动态覆盖限于报告中的纯函数/源代码断言；其他生产和消费链均标为静态。没有真实模型、付费 API、账户、用户文件、外发消息、产品网络/native/PTY、auth/permission/security/custody/watchdog 实验，也没有共享依赖/dist rebuild、完整 build/typecheck/lint/suite 或 E2E 通过主张。独立 codeshell-panel-apps 仓库未纳入本批全量审查。
