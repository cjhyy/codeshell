# 第十八批：环境描述的普通元数据形状

冻结源码：`65691923fa629970ac26dc04e35362a9c4ab57a8`。本分区 **0 项确认缺陷、0 项候选**。该模块已有 [完整静态审查](../review-remaining-2026-10-12/hosts.md#L73)，本批只补普通数据的实际 helper 对照，不将其称为此前未读源码。

动态仅绝对导入无依赖的 `packages/web/src/lib/environment.ts` 并调用 `isEnvironmentDescriptor`。固定的自有格式合法 UUID 字符串仅作 DTO 字段；没有运行身份服务、生成/读取持久化身份、其他来源替换或导航。`projectReferenceKey` 只静态阅读；库存查询仅找到公开 export 和测试直接使用，没有实际生产者，故不由其自造输入登记用户 bug，也不调用它。

唯一首次命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round18/evidence/root-environment.test.ts
```

[combined raw](evidence/root-environment.first.log)、[exit receipt](evidence/root-environment.first.exit.json) 先保存再检查：**6 pass / 22 expect / 0 fail / 0 skip，Completed、exit 0**，全部新 focused。普通 metadata 控制覆盖三个静态 producer 形状、英文/中文/emoji name、冻结对象不变性、非空 name 长度、版本与 kind/entryPath 对应、普通非 descriptor 值。后几项是结构合同的负向控制，不是身份/认证边界或恶意目标实验，没有恢复旧 auth/permission/security 动态方向。

生产者 `packages/server/src/environment-identity.ts:57–69` 静态返回 desktop `/mobile` 和 hub/project-host `/`，名称为普通本地化文本。文件包含身份文件操作，未导入或执行；只把 descriptor 构建选段作为本批合同。消费者 `packages/web/app/EnvironmentMenu.tsx:48–57` 在 discovery response 后调用 guard，`app/environments.ts:41–50` 将存储条目的 id 放入固定普通 descriptor 验证；两者仅静态选段，未导入 React/auth/storage/navigation 模块。既有 `environments.test.ts` 只搜索相关引用，未执行整组或其其他边界场景。

实际对照未得到普通 descriptor 合同违例。它们不证明服务身份可信、存储生命周期、跨来源行为、页面验证或 UI 展示正确，也不把 schema shape 检查说成整个 Environment 产品验证。Root 没有 fixture、导航、preflight 或 Bun 失败，没有产品重跑。

[全历史查重](evidence/root-dedup.json) 覆盖本批外 prior docs/bugs 的 **1,148 MD + 847 parsed JSON = 1,995 文件、253,680 JSON 字符串叶子、0 parse errors**，含存在的 archives；9/4 次关键词匹配与每类 120 段上下文上限分开。旧 hosts.md 的全面静态读取明确承认，关键词不是语义穷尽证明。

[preflight](evidence/root-environment-preflight.json) 只核实际源文件和冻结 Git bytes，没有 package resolver/猜测依赖位置。[source manifest](evidence/root-source-manifest.json) pin 已选源码和阅读范围，整文件 SHA 不等于整文件新审查或所有依赖验证。没有实际服务、用户数据、账户、模型、网络、native/PTY、权限/auth/security/custody/watchdog 实验，没有 build、共享 deps/dist rebuild、full suite/typecheck/lint 或 E2E 主张。
