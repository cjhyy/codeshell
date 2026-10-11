# 复现证据

这些脚本包含缺陷表征和用于排除误报的常规契约验证；其中缺陷表征测试通过代表复现成立。修复产品后，部分断言应当失败；它们不是永久的产品回归断言，也不属于默认 `tests packages` 测试集合。

在仓库根目录安装冻结依赖并完成构建后运行：

```sh
node docs/review-2026-10-12/run-reproductions.mjs
```

入口逐文件调用项目 guarded runner，隔离 HOME、应用状态和提供方凭据，并检查完整 JUnit 结果。单个文件也可传给 `node scripts/run-bun-test-shard.mjs --timeout 30000`。网络 fixture 只使用受限本地模拟源，不调用真实模型。不要改成直接运行 `bun test`。

导入路径已改为相对仓库路径。原始专项分析中的 `/tmp/...` 是审查时的原始证据路径；本目录保存了相应脚本和最终日志的副本。

`root/active-snapshot-journal.json` 是真实 native Hub/worker 使用本地模拟模型产生的首次运行响应，工作目录是已清理的临时 fixture。对应测试同时覆盖生产客户端恢复函数和服务端 baseline 裁剪。

第五轮凭据脚本为实际 Electron 测试，另用原生隔离入口运行，不计入 Bun 文件数量：

```sh
node scripts/run-isolated-node-smoke.mjs docs/review-2026-10-12/reproductions/credentials-round5/credentials-e2e.mjs
```

截至第十六轮，初始基线 Bun 便携证据共 72 个文件、221 个测试；同样在 0.9.33 分别复核。凭据脚本另含 4 个实际 UI 场景。新功能专项另见 `latest-reproductions/` 与 `run-latest-reproductions.mjs`。

第十一轮的工作区恢复与搜索脚本共新增4文件8测试；stable project scope恢复对照仅在0.9.33新功能目录。原生下载脚本及单次运行证据在 `../validation/download-round11/`，不计入Bun总数。

第十三轮新增6文件48测试304断言，两基线分别通过；包含终端/Review 2测试、会话操作4测试、多窗口36测试（其中33为既有保护wrapper）、配对Web生命周期6测试。缺陷与正常控制、完整Electron/native与组件替身范围见各专项附录。

第十四轮通知1文件3测试19断言、终端1文件6测试41断言、Desktop/Web文件2文件4测试70断言；合计新增4文件13测试130断言，两基线分别通过。真实Electron reload身份单列 `../validation/terminal-lifecycle-round14/`，仅a66f/macOS，不计为Bun或真实PTY实验。

第十五轮新增6文件12测试142个Bun断言，两基线分别guarded通过：CLI3文件7测试108断言，远程设置1文件3测试23断言，连接2文件2测试11断言。连接的native-outbound.test.ts通过run-isolated-node-smoke调用同目录outbound-native.mjs，另有33个native断言/基线，已包在一个Bun测试内，不另算新Bun文件或测试。原始诊断位于validation/original-connection-recovery-round15/diagnostics，文件后缀不是活动test，不收集/累计。

第十六轮新增4文件10测试104个Bun expect，两基线分别guarded通过：项目1文件3测试27断言，设置1文件1测试2个expect，Link1文件5测试73断言，MCP1文件1测试2个expect。设置owned Bun helper另27个手工assert，MCP经maintained native isolator另22个Node断言；都包含在对应wrapper测试内，不增加Bun测试/expect。人工owner-delay诊断在validation/original-command-recovery-round16/diagnostics，仅文本后缀、不进collector。
