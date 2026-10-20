# 只读复核：普通 Environment descriptor

结论：接受 `environment.md` 的 **0 确认 / 0 候选** 与 **6 个 focused 测试 / 22 次断言 / 0 fail / 0 skip**。没有需要扩大产品结论或新增运行的事项。本复核只写当前文件；没有运行产品、测试、服务、身份/存储/导航逻辑或任何 Git 命令。

## 证据核对

- 先按真实库存找到 `environment.md`、`root-environment-preflight.json`、`root-environment.first.exit.json`、`root-environment.test.ts`、`root-source-manifest.json`、`root-dedup.json`。原始 `.log` 被常规 `rg --files` 忽略，随后依据报告里的明确链接读取已有 `root-environment.first.log`，没有猜测另一个 suffix，也没有重新生成输出。
- 首轮退出回执的命令确为 `node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round18/evidence/root-environment.test.ts`，`firstRun: true`、exit 0。已有 raw 显示六个用例全部 pass、`22 expect() calls`，结尾为 `Completed Bun shard: 6 tests, 0 skipped; 0 failures.`。首次保存顺序来自作者回执/报告，本复核没有重复运行来替代它。
- fixture 只有 `bun:test` 与无依赖 leaf `packages/web/src/lib/environment.ts` 的绝对 import，仅调用 `isEnvironmentDescriptor`。固定自有 UUID 只是 DTO 字段；三个正常 kind/entryPath、普通本地化名称、冻结对象、name 长度与版本/路径配对、普通非 descriptor 值是形状对照。没有调用 `projectReferenceKey`，也没有 import producer、React、auth、storage 或导航模块。
- 静态读取 `environment.ts:1–43`，以及 `environment-identity.ts:57–69` 的 descriptor 构造段、`EnvironmentMenu.tsx:48–57` 和 `app/environments.ts:41–50` 的 guard 消费段。所述三个返回形状及普通消费者均与报告一致；没有读取或执行 producer 中的身份文件动作来补证。
- 当前 `packages/**/*.ts(x)` 的 `projectReferenceKey` 引用只有实现、公开 export、既有 mixed test。这个源码库存没有普通产品消费者，报告不调用它、不由其手造输入登记 bug 的边界合理。没有运行既有 `app/environments.test.ts` 或其中负向片段。
- 10 项 source manifest 的当前文件 SHA-256 与 bytes 全部匹配已保存值。冻结 Git pin 来自已有 manifest/preflight；本复核遵守零 Git 命令要求，未独立重新读取 Git blob。SHA pin 不能推广为整个 Environment 产品或全部依赖的新审查。
- 已读旧 `hosts.md:70–88`，其中 `:73` 明确记载 full `src/lib/environment.ts` 及相关 Web 静态阅读。报告承认这段历史，没有将本批称为此前未读源码；本批新增证据是普通 helper 的首次实际对照。
- `root-dedup.json` 为 1,148 Markdown + 847 parsed JSON = 1,995 文件、253,680 JSON string leaves、0 parse errors；9/4 为实际匹配计数，120 是每 pattern 的上下文上限。inventory 含 169 个 archive/_archive 路径、没有本批路径，全部 1,995 个已有文件的当前 hash 匹配 inventory。该统计没有把 string leaves 说成全部 scalar leaves，也没有把关键词索引说成语义穷尽证明。六个报告链接的本地文件目标存在；旧报告的 `#L73` 仅核对其文件和实际第 73 行内容，没有浏览器导航/锚点行为验证。

## 本复核的元数据错误转录

首次只读 JSON 收集器只排除了猜测的 `contexts`/`matches` 字段，实际 `root-dedup.json` 使用 `hits`/`inventory`，因此误将完整 1,995 项库存打印到工具输出。该第一次响应为 exec chunk `1f1390`、exit 0，工具报告 `original token count: 106463` 与 `Warning: truncated output`。这是输出收集范围错误，不是产品、fixture、依赖或 Bun 失败。后续只重新读取有界统计、匹配数量和库存 hash，未修改受审材料或新增产品运行；没有把截断输出冒充完整人工阅读。

报告所保留的限制与实际证据相称：没有真实 identity service、Host/server、用户数据、网络、auth/security/permission/custody/watchdog 实验，也没有 full suite、build、typecheck、lint 或 E2E 结论。
