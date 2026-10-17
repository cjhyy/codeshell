# 历史查重范围补充（仅元数据）

首次去重按路径中的 audit/review/archive/_archive 或 bugs 选择了 1,168 个 Markdown/JSON，收据原样保留在 [初始子集](patch-dedup-initial-selected.json)。这包含所有该筛选命中的归档，并逐层解析 JSON 字符串叶子，但没有涵盖普通 architecture/specs/todo 等文档。

收到 root 的范围核对要求后，改为 `rg --files docs bugs` 的全部 `.md` / `.json`，仅排除当前 round12 目录。补充后共 1,658 个文件，278 个关键词匹配，0 个读取/解码/JSON 解析错误；完整 SHA、命中位置与片段见 [最终去重](patch-dedup.json)，元数据脚本见 [patch-dedup.py](patch-dedup.py)。初始大库存工具显示曾截断输出，但去重脚本使用完整 `rg` 标准输出列表；没有据截断文本声称覆盖范围。

新增范围内的 ApplyPatch 命中是架构、工具路径、undo、routing 和历史说明；没有发现与合法、带 marker 的首空白 context 被 outer parser 丢弃相同的记录。旧 May 30 unmarked blank acceptance 的完整对象已读过，触发条件与分支不同。关键词加有限上下文仍有语义查重限制。

本次只补充文档查重和说明；未修改 fixture、首次日志或退出码，也没有重跑任何产品测试。没有导航失败或未解析历史文件。
