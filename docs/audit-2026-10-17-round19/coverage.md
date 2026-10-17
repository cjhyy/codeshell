# 第十九批范围与验证界限

冻结点 `5f5cf69df8526470700712a4dc2d5ae6bd2da132`；报告仅在独占审查 worktree 写入本批 docs。完整任务仍是持续全仓审查，独立 `codeshell-panel-apps` 仓库没有被本批全面审查。

实际运行四个小型叶模块：Coding review parser/builder、Core stream timing、simple diff、undo selectors。四组首跑 **71 tests / 187 expect**，**43 existing + 28 focused**，全部 Completed/exit 0，无失败/过滤/重试。只有 reviewprompt 两个 focused characterization 用例证实帮助/解析矛盾；没有将通过测试说成产品修复。全部实测为真实叶调用，没有镜像 CLI/hook/Engine 配方替代真实集成。

TUI review 命令/registry/control surface/hint、Engine/run-stream/publisher、FileHistory plan、undo 命令及其他相邻模块仅按各分区 manifest 选读。整文件 SHA pin 不等于整文件/所有依赖/所有分支新审查。UI、实际命令、Git 产品调用、模型、回放、持久化、文件恢复、终端渲染均未执行。默认系统时钟和异常时钟、无普通 producer 的无效 context/上限参数、legacy selector 的现行 TUI 可达性不在验证结论内。

全历史索引读取 prior docs/bugs MD 和递归 JSON scalar values，含 archives、排除本批；2,050 文件、260,970 string leaves、363,859 scalar leaves、0 parse errors。每方向上限不同的上下文和总命中数分开，相关旧报告另行阅读；没有仅凭零关键字命中宣称新机制。旧 `R2-03` 围栏和 `DESKTOP-R12-01` UTF-16 机制只 related，不重复计 bug。旧 created-only undo 记录、round4 earlyInput/recorder、round9 usage、旧 TUI Diff/解析器等排重或跳过，不从本批纯函数结果恢复其动态方向。

Root、timing、reviewprompt、simplediff 构成只读交叉复核环，分别核源字节、raw/exit、夹具、计数与声明边界；最终聚合另核全部 artifact/source/index/链接。原始 raw 永远不规范化。Root 猜错旧文档名、timing 不存在 glob、publisher 范围描述、只读输出截断和 reviewprompt 补齐静态中间转发链均有显式 metadata 记录；没有产品修复或再次验证。

并发 main 从冻结点前进两条提交，只改 `docs/todo/release-real-operations-2026-10-16.md`。已选源码 frozen/current/main 相同；历史去重库存是读取当时快照，不断言外部 release 文档当前 SHA 仍等于旧库存。Primary 的 dirty 删除与四个 untracked files 保持原字节，最终只允许 disjoint 本批 docs 的 fast-forward。新 frontier 辅助任务容量错误是调度失败，没有测试/产品错误证据，未重试。

没有实际模型/付费 API/账户/外部消息/用户文件/product network/native/PTY/auth/permission/security/custody/watchdog 实验；没有共享依赖或 dist 重建、全面 build/typecheck/lint/suite/E2E，也没有 push。保留工作树继续审查。
