# CodeShell 第八批审查记录

冻结源码 `ec0e16bf0068a458abcbaa28225a4c764c24f4de` 上新增确认 **6 项 P3**，另保留 **2 个未确认候选**。其中 WEB-R8-01 已被并行主线改动从源码层面修复，未在新主线重跑；不能将六项统称当前仍未修复的 bug。本批没有产品修复，持续全仓审查仍未完成。

| ID | 冻结基线已确认问题 | 本批证据与状态 |
| --- | --- | --- |
| GIT-R8-01 | 同一个带引号路径在 committed/dirty 集合形成两个身份，changedFiles 多计 | [root-git.md](root-git.md)；真实摘要、内存 Git 输出，未启动 Git 产品进程 |
| PLUGIN-R8-01 | 空引号参数消失，后续命令位置左移 | [plugins.md](plugins.md)；真实 expander/converter，自有 tmp |
| PLUGIN-R8-02 | `$ARGUMENTS` 前缀抢先吞掉完整命名 placeholder | [plugins.md](plugins.md)；命名/未知 literal 对照 |
| PLUGIN-R8-03 | 已接受 Windows marketplace 路径派生下一步会拒绝的 name | [plugins.md](plugins.md)；纯 parser/deriver/guard，未 clone 或 Windows 执行 |
| WEB-R8-01 | `/` 项目不能归属后代 cwd | [web.md](web.md)；冻结基线复现，并行提交 `658b8c6f...` 已源级消除 |
| WEB-R8-02 | `image/jpg` alias 提前返回，跳过客户端每图大小检查 | [web.md](web.md)；真实准备函数、内存上传替身，无真实上传或服务端接受结论 |

[questions.md](questions.md) 新增确认 0 项，两个候选单列 [candidates.json](candidates.json)：Mobile 多选 hint 缺失但合同不足且 fixture import 失败；TUI 合批按键 fixture 的独立 flushed 控制也失败，不能证明 batch 特异性。两个失败方向均保留首次材料，未修复、未重试、未换方法补证。

共 **10 次首次 Bun shard**：**8 个干净分片，64 pass / 203 expect / 0 fail / 0 skip**。包含 39 项现有基线与 25 项新增聚焦观察/对照，不能称 64 项新 bug 测试或全仓 gate。另两个 Questions 失败分片合计 0 pass / 3 fail / 6 expect calls，单列保留；SKIP 表示审查方向处置，不冒充 Bun test skip。A03/A04、旧 CC 多题截断、sticky card、路径大小写等已有问题未重复计数或重跑。

机器索引：[确认发现](findings.json)、[候选](candidates.json)、[首次验证计数](validation.json)、[冻结源码清单](source-manifest.json)、[最终材料 SHA](evidence-index.json)。[质量复核](quality-review.md) 及三份只读交叉复核核对合同、正常触发、限制和收据。所有产品测试仅属于原冻结基线；[集成上下文](integration-context.md) 单列并行主线变更与源码已消除状态。

本批仅增加审查文档、fixture 与证据，没有模型、付费 API、账户、用户数据、真实外部服务、native/PTY、权限/安全/平台实验，没有构建依赖/共享 dist 或运行全仓 build/typecheck/lint/test。独立 `codeshell-panel-apps` 仓库未在本批做全仓审查。
