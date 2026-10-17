# 第十六批：Core minimal memoize

冻结基线：`ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f`。本分区 **0 项正式 bug，0 项候选**；没有修改产品。

完整阅读 `packages/core/src/utils/memoize.ts`。模块合同是供当前调用点使用的最小 resolver-key 缓存，提供 `.cache.clear()`，生命周期随返回函数，明确不是 LRU。动态只导入这一无外部依赖的模块，以自有同步 callbacks 和字符串 key 调用真实 memoize，不导入 scanner、plugin loader、Core barrel 或 settings。

唯一首次 guarded command：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round16/evidence/root-memoize.test.ts
```

[combined raw](evidence/root-memoize.first.log) 与 [exit 收据](evidence/root-memoize.first.exit.json) 已先保存再查看：**7 pass / 36 expect / 0 fail / 0 skip，Completed、exit 0**，全部为新增观察/正常对照。实际文件存在和冻结 Git bytes 的 [preflight](evidence/root-memoize-preflight.json) 只读元数据，没有尝试 package resolver。没有既有独立 memoize 测试被声称运行。

真实观察覆盖：resolver 接收参数且每次调用都重算 key；相同 key 返回同一计算对象；`undefined`、false、0、null、空串均正常缓存；side-channel key 改变后计算新条目且旧 key 仍可命中；`.cache.clear()` 后重新计算；`__proto__`、`constructor`、空字符串三个普通 key 无碰撞；同步 callback 抛错不会写入缓存，同一 fixture 随后的调用正常计算。最后一项是预先设计的 fake callback 控制，不是失败 shard 后的产品验证重跑。

普通消费点只读选段：`packages/core/src/plugins/pluginCommandsLoader.ts:198–215` 以 home/registry mtime 构造字符串 key，并显式 clear；`packages/core/src/skills/scanner.ts:350–381,429,475–477` 以 cwd、home、registry/directory mtimes、pins 构造 key，filter 在缓存后处理，另有显式失效入口。未调用任何 scanner/loader、mtime 查询、文件读写、home resolver 或安装流程。因此动态证据仅证明缓存 helper 合同，不证明外部 key 失效策略或用户目录扫描正确。

scanner 目录缓存、已有内容编辑需显式失效及旧 Skill 路线已在 [既有审查](../audit-2026-10-17-round6/skills-agents.md) 说明，本批不恢复旧失败动态方向。明确设计的非 LRU 生命周期、未承诺的 receiver 绑定或替换整个 `.cache` 属性不作为新 bug；当前生产者未使用这些形态。未据此编造 async/rejected-promise 缺陷，当前 callbacks 是同步扫描。

[历史查重](evidence/root-dedup.json) 覆盖本批外 docs/bugs 的所有 Markdown、递归解析 JSON 字符串叶子和存在的 archives：**1,119 MD + 763 JSON = 1,882 文件，222,452 字符串叶子，0 解析错误**。memoize/失效关键词分别 246/53 次匹配，保存的每类上下文最多 120 条，不把上下文上限当匹配总数或语义穷尽证明。

一次静态拼写猜测失败单列于 [导航转录](evidence/root-navigation-skip.md)，不当产品或 Bun 失败。Root 还为专项讨论只读 tabstops/bidi 与 output 的选段；它们没有在本分区导入或执行。冻结 source pins 和逐文件阅读范围见 [root source manifest](evidence/root-source-manifest.json)。没有实际 CLI、Engine、模型、网络/账户、用户文件、TTY/native、安全/权限/custody/watchdog 实验，没有 build、共享 dependency/dist rebuild 或全 suite/typecheck/lint 主张。
