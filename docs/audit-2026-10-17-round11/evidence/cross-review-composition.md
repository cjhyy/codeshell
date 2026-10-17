# 只读交叉审查：组合配置与冻结数据

审查者：Chat 子任务。对象为 `composition.md`、`root-composition-controls.test.ts`、两个 FIRST raw logs/exit、root findings/candidates/validation/source manifest/navigation skip/dedup，以及 compiler/freeze/preset resolver/snapshot/core-module 的相关源码和既有 baseline 测试。**没有新增/重跑测试，没有 Git mutation 或产品编辑。**

结论：支持 **0 新确认、0 候选**，没有阻碍整合的问题。

- 两份首次 raw logs 与 exit 收据一致：新增普通控制 3 pass/18 expect，既有 baseline 6 pass/426 expect；总计 2 clean shards、9 pass/444 expect、0 fail/skip。`root-findings.json` 与 `root-candidates.json` 都是空数组，报告没有把正常控制误当成 finding。
- Fixture 直接导入真实 compiler/freeze/preset resolver/snapshot。普通对象字段复制后独立、输出声明冻结、作者输入未冻结；普通 preset 选择与新 prompt record、query/prompt topology 顺序的断言与源码一致。dummy tool/query callback 的计数均被断言为 0，编译器只收集其引用，未执行这些 callback。既有 baseline 也只比较内置声明和 snapshot；没有调用实际工具/Engine/provider/Host。
- Snapshot 源码显式投影名称、owner、顺序及 topology 元数据，没有 schema/prompt 正文或 callable 实现。报告没有把同 topology 下不同正文的相同 digest 升格成 bug，也没有把内部相对路径 import 当作稳定外部 SDK export 证明。
- 独立逐项以 frozen `git show b8b776d56e5982e59b18de0262d5c49367746625:path` 和当前文件重算 18 个 source 的字节数与 SHA，**18/18 相等，0 mismatch**。该检查只是选定 source 收据，不能证明完整传递导入图或全仓动态覆盖；报告已明确这个限制。
- 两个猜测路径导航失败已单列转录；首条管道导致整体 exit 0，单个 rg 路径仍失败，第二条 sed exit 1。报告准确区分导航错误与 Bun shard，明确跳过对应 export/type-file 方向，没有声称由这些失败建立 public export 承诺。
- activation/lifetime/authority 相关仅静态阅读，既有测试库存存在不代表已执行。无全仓 build/typecheck/lint/suite、原生资源激活、真实网络或平台验收结论。

保留的实际范围为普通声明 metadata 的定向编译/拷贝/投影控制；本次复核不把 green shards 扩大解释为所有 composition 形态或所有运行生命周期正确。
