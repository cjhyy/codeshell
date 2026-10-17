# Root traces / baseline refresh：独立只读复核

结论：支持 traces.md 的 **0 formal / 0 candidate** 与窄验证范围；没有需要升级的报告错误。本复核没有运行、新增或修改任何测试，没有调用产品入口或写入他人报告，Git 操作为只读。

实际核对：traces.md、baseline-refresh.md、root-trace-data.test.ts、root-trace-data.first.log / root-trace-data.first.exit.json、root-source-manifest.json、root-dedup.py / root-dedup.json、root-navigation-skip.md；完整阅读 modelTracePresentation.ts、openActivitySession.ts 和 useModelTraceSessionTitles.ts 当前源码，并检查两项已知修复的 Git diff。原始 root raw SHA-256 为 `f9eaa4b80be2810db35d37cb03bd0b07b165e7b742cb9bff0d06c2951235f92d`。

- 首 log 是 **6 pass / 32 expect / 0 fail**，guard 明确 Completed 6 tests / 0 skipped / 0 failures；exit receipt 0，具体命令为 maintained guarded runner + 单个自有 fixture。六个测试体的断言范围和源码相符。它们是新纯 helper 控制，不能当成既有 UI suite、完整 backend record producer 或真实 trace 运行覆盖。
- helper 两个依赖 import 均为 type-only；key-echo `t`、仅保留 id/traceId/startedAt/parentId 的普通内存投影由 fixture 明示。实际测试没有 IPC、React、Core barrel 或翻译运行时。调用排序返回新数组、group 输入不变、最大四层与环终止均由当前源码和断言支持；未知 status、非有限 time、破损 parent 的防御控制没有被报成正常生产者 bug。
- root-source-manifest 中 **14 个条目**均重新从冻结 commit `badc2262a90966f6f903977b849adf1f22b55e9f` 读取 Git blob，SHA-256、bytes 和当前文件逐一相符。条目区分 full read、selected source excerpt、type-only 与 guard pin，没有把未执行组件或后台生成链算成动态覆盖。
- root-dedup 脚本遍历 docs/bugs，排除当前 round14，JSON 递归解析字符串叶子。收据 **1088 MD + 680 JSON = 1768 文件 / 185197 字符串叶子 / 0 parse errors** 与 inventory 数量相符；2 个精确 helper 命中是旧库存记录，关系关键词命中为其他设计/审查上下文。报告保留 bounded keyword search 的局限，没有宣称语义查重完备。
- 首次猜测 Core model-trace 文件夹的 rg 错误已单独标为工具响应转录，管道 exit 0 与 rg 缺目录错误没有混为成功；后台方向保持 skipped，复核也没有绕道读/执行该方向。
- `git log b4702dcc..badc2262` 的八条新增提交、CODESHELL/AGENTS 无差异，以及 `9925b3282` / `3d6a1ec35` 的直接 diff 支持 baseline-refresh。Unicode 摘要在 surrogate 边界后退一单位，生成图片完整路径按 formatter tail 保留，确实触及早先根因；报告仅称 source addressed，明确不复跑旧错误实验、不借用他人 UI/native 验证作为本轮证据。未执行任何修复验收。

原始 first-run 先捕获再检查的时间顺序由 root 的保存工作流说明；本只读复核能验证现有原字节和退出收据一致，但不重新制造一次“首次执行”。0 formal 结论是本批所审范围内的登记结果，不等于所有 Web/Desktop/trace 内容无 bug。
