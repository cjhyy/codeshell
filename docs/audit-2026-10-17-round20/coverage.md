# 第二十批证据范围

本批不缩小持续全仓审查目标；选择新的叶函数边界控制作为一个检查点，独立 `codeshell-panel-apps` 仓库没有被全面审查。所有产品源码以 `d40dd06987a2e0c20c377e243cf5c4e4b549c9ec` 冻结。

实际运行：TUI `parsePositiveInt`/`positiveIntOption`（真实 Commander 依赖）、Core `generateToolUseSummary`（唯一 runtime logger 精确 preimport warn spy；自有 fake async callback）、TUI `StreamAttempt`（store type-only）、Chat `mediaKind`（mixed module 的 builtin net import，无网络调用；deny-fetch 先于 import）。46 个直接叶测试，7 existing +39 focused，127 raw expectations，4/4首次分组 Completed/exit0、0 fail/skip/retry。没有手工镜像整个 CLI/App/Engine 配方。

Tool summary 14 个测试中 11 是普通控制，3 个是手工非 Error rejection 关联。它们不证明普通 provider 会产生 null/undefined，也不证明未处理拒绝、进程退出或 UI 失败；有普通 Error/取消的对照，真实下游 catch 仅静态选段。旧非 Error catch 机制只 related，没有重复计新 finding/candidate。整数超精确范围不是新安全整数合同；旧 round15 精度/NaN 排除保留。StreamAttempt 保持旧 round7 baseline、Desktop F-01、history mapper/provider配对排重。媒体冲突、CHD02 截断、Web MIME alias 大小路线不恢复，未知扩展名没有被自造为支持要求。

普通消费者和 producer 只静态选读，各 manifest 明确 scope；完整文件 SHA 不等于完整模块或传递依赖已运行。没有实际 CLI/native/Git产品命令、模型/付费API/provider、App/React/Ink/store runtime、真实 timer/replay/accounting、附件 byte loader/downloader/adapter、真实 log/filesystem 恢复或 auth/permission/security/custody/watchdog 实验。所有测试字符串、数组、callback 与 ID 都由 fixture 持有；filename/backup metadata 不代表实际用户文件。

全历史查重含 prior docs/bugs MD、递归 JSON scalar 值和 archives，排本批；2,109 文件、267,491 string leaves、373,239 scalar leaves、0 parse errors。总命中与上下文上限单列，相关旧记录另行阅读，宽泛误命中和未完整显示的输出不算完整语义覆盖。当前去重是 read-time snapshot，不承诺所有历史文档在最终 main 永远不变。

四个 scope 的只读交叉复核均保存。独立聚合复核和 Root verifier 再核分类、first receipts、source/artifact/index hash、文件及 line anchors。原始 raw 不做 whitespace/ANSI 格式化；只 force-add 四个实际 receipt 对应日志。只读导航和显示截断、Root 把 read-command 上界改写为实际完整93/38行的 metadata 修订均披露，0 产品重跑。

合并前 refresh 后 main 未从冻结点前进；initial/premerge snapshots 保持原 deletion 和四个 untracked bytes，最终仅在 HEAD/dirty 再核相同后 fast-forward 自有 docs。没有共享 deps/dist 重建、全面 build/typecheck/lint/suite/E2E、push 或完成全仓目标的声明。
