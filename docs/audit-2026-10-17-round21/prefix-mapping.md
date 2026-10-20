# 第二十一批：普通分支前缀映射补查

冻结点 `615e4e4dd3a61b1ad132ab4f3683985a0d582386`。本分区 **0 确认 /0 候选 /0 related**。实际只调用 [`normalizeWorktreeBranchPrefix`](../../packages/coding/src/git/worktree/slug.ts:16) 和 [`managedBranchPrefixes`](../../packages/coding/src/git/worktree/slug.ts:49)，所有输入为短的普通有效命名字符串；没有对真实 branch、工作树或仓库操作。

唯一首次命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round21/evidence/root-prefix.test.ts
```

[combined raw](evidence/root-prefix.first.raw.log) 与 [exit](evidence/root-prefix.first.exit.json) 先保存再检查：**7 pass /17 expect /0 fail /0 skip，Completed、exit0**，全部 focused，0重跑。对照省略/undefined 默认前缀、一级/层级前缀、已有 trailing slash、配置空白 trim、短 Unicode 标签、默认与历史 namespace 去重、configured-first 列表顺序与 caller 自有数组。Unicode 只是字符串映射输入，没有创建 Git ref 或验证任何平台兼容性。

真实 module 无 runtime imports，绝对路径直接导入，没有 mocks/摘抄。[预检](evidence/root-prefix-preflight.json) 核对实际库存文件、frozen Git bytes、零 import 和绝对 fixture import；没有 resolver 或依赖目录假设。normalize 内部对普通有效值调用 predicate，但本批没有直接运行 validator 的无效/攻击输入，也不调用 `isManagedWorktreeBranch`、applyPrefix、ownership/cleanup gate 或任何创建/删除判断。

[`settings/schema.ts:80–86`](../../packages/core/src/settings/schema.ts:80) 的配置 schema 与 [`worktree:339–343`](../../packages/core/src/settings/schema.ts:339) 默认值只静态核对；[`tools/worktree.ts:140`](../../packages/coding/src/tools/worktree.ts:140) 读取 configured prefix；[`query.ts:140–165`](../../packages/coding/src/git/worktree/query.ts:140) 和 [`crud.ts:112–130`](../../packages/coding/src/git/worktree/crud.ts:112) 的命名/分类消费只选读，没有导入 Zod、settings manager、Git executor、Host/native 或执行产品动作。纯字符串对照不证明 branch 归属、cleanup 安全、名字可创建或真实工作树功能。

该模块并非此前未读或未运行：旧 [round8 baseline](../audit-2026-10-17-round8/root-git.md:23)、[round13 baseline](../audit-2026-10-17-round13/git-text.md:14) 已将完整5个 slug existing tests 与 parse-log 合并运行8/17。本批仅静态读这5个 tests，不重跑 parse-log、旧 A03/A04/GIT-R8-01 或 validator/managed-branch 方向；新7个仅为普通 normalize/list 控制。

[历史扫描](evidence/root-dedup.json) 覆盖 prior docs/bugs MD+递归 JSON scalar值（含 archives、排本批）：**2,169 文件 =1,189 MD+980 JSON，288,528 string leaves /404,370 scalar leaves，0 parse errors**。13/14/2,789/4 为四类总命中，上限120上下文分开；宽泛 A03/A04 模式还可能命中字节 hash，不把它等同2,789条语义相关记录。已直接核对前述旧 baseline；关键词不是语义穷尽证明。

上批只读 prep 提案冻结在 d40，当前 actual pins 已针对615重新核对。该提案最初把所有 baseline 都排除过严，后来只保留普通映射控制；本批承认旧覆盖，不称新模块。其余 Git/Host/ownership/native 耦合目标不因本 pure leaf 通过而恢复动态验证。精确范围见 [source manifest](evidence/root-source-manifest.json)。本 Root 方向没有导航、preflight 或 Bun 失败，没有实际CLI/模型/网络/native/PTY/用户文件/权限/auth/security/custody/watchdog实验，也没有 build/typecheck/lint/full suite/E2E 或产品修改。
