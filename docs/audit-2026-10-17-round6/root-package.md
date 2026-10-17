# 构建、发布元数据与测试入口

本方向新增确认 **0 项**。冻结源码为 `cef9ff76167d33a6a6e5b4464ba5313f7fd35f79`；这是有限源码核对和现有基线测试结果，不代表发布链、全部包或全仓无 bug。

## 已核对范围与结果

读取 `scripts/build-meta.ts`、`scripts/check-node.cjs`、`scripts/verify-release-versions.ts`、`scripts/package-release-audit-config.ts`、`scripts/publish-release-packages.ts`、`scripts/package-release-smoke.ts`、根 `package.json` 和测试隔离入口。核对包声明、公开/私有包分类、版本来源、依赖顺序、CLI 兼容路径、发布确认和参数模式。既有任务分支打标签缺陷已有旧记录，本批不重复计入。未找到足够证据确认新的发布缺陷。

唯一首次 guarded 分片：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 tests/build-meta.test.ts tests/package-boundaries.test.ts
```

结果为 **17 pass / 123 expect / 0 fail / 0 skip**，有 `Completed Bun shard`，exit 0。原始合并 stdout/stderr 为 [root-package-baseline.first.log](evidence/root-package-baseline.first.log)，[exit](evidence/root-package-baseline.first.exit.txt)，[receipt](evidence/root-package-baseline.receipt.json)。17 项均为现有测试，未为静态代码字符串增加镜像断言。

`tests/build-meta.test.ts` 将生产构建脚本逐字复制到自己创建的临时目录，使用 fake TUI 验证当前和旧 CLI 入口、传参及清除过时文件。它没有构建本仓共享 `dist`，也没有启动真实 CLI 产品功能。包边界测试只读取源码/manifest，并调用元数据验证函数；没有 npm 查询、发布或网络请求。

## 保留的静态候选，未计入确认

`package.json:42` 的 `test:watch` 仍直接调用 `bun test --watch`，与 `CODESHELL.md:140–145` 所述 unit shard 采用 guarded runner 的操作要求不一致；`scripts/bun-test-completion.mjs:117` 又明确拒绝 watch 参数。静态上可确定两条入口不同，但本批未运行 watch，未检查操作者状态、凭据或外部行为，也没有进一步确认该脚本的维护意图和实际运行影响。因此仅记录为待核对的测试入口配置候选，不定优先级、不作为产品缺陷、不展开安全实验。

## 证据边界

未在共享 checkout 执行构建脚本或构建共享 `dist`；仅执行临时目录中的逐字副本。未执行完整 package release smoke、打包安装、真实发布、CLI watch、真实应用、模型、远端服务或平台实验。`package-release-smoke.ts` 的完整模式会 clean-build 多个包，包含本批范围以外的消费者验证，因此只读审查。未运行全仓 build/typecheck/lint/test；复用现有依赖，不能由这 17 个测试推断干净安装后发布成功。所有产品文件保持不变。
