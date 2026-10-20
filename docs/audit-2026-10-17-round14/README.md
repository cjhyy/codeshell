# CodeShell 第十四批审查

冻结源码：`badc2262a90966f6f903977b849adf1f22b55e9f`。本批 **0 项新增确认 bug、4 个候选、1 个旧家族关联**；另记录两条旧 finding 的源码已由其他任务修改。只写审查文档和证据，全仓目标持续，本批结果不表示全部完成或其他模块均无 bug。

| 编号 | 候选 | 证据边界 |
| --- | --- | --- |
| UTIL-R14-C1 | Slice 的 UTF-16 索引与显示列调用边界可能不一致 | 首次 fixture 导入失败，只有源码推演；wide-character 完整保真限制已披露 |
| UTIL-R14-C2 | Slice 可能丢掉最后字符后的 SGR reset | 同一失败方向保持跳过，未观察真实样式泄漏 |
| WEB-R14-C1 | 普通用户 XML 可能被误作内部附件标记剥除 | 首次 fixture 导入失败，只有普通文本合同与源码分支 |
| BYTES-R14-C1 | JPEG SOF3 识别与无条件 DQT 前提可能不一致 | 实际自造字节拒绝，但未独立证明样本可解码或普通下游支持合同 |

详见 [Core 工具函数](utils.md)、[Web 展示](web.md)、[Server 字节探测](bytes.md)、[模型 trace 展示](traces.md)。Core toolDisplay 的 UTF-16 截断只关联旧 Desktop 家族，未独立确认；Desktop 修复不等于 Core helper 已修复。

**4 组完整首跑：31 pass、78 expectations、0 fail/skip**，其中 14 项既有基线、17 项新增 focused 对照/观察。另有 **2 组首次加载失败，各 0 pass、1 fail、1 error**；源模块和测试体均未加载，整条对应动态方向跳过，没有修 fixture、重跑、提取函数或换现有测试恢复验证。另一份 cache/semver/toolDisplay fixture 从未执行，attempt=0，保留原样，断言不作证据。

共 6 份首次 combined stdout/stderr raw logs 和退出收据，均先保存后检查。[validation](validation.json) 直接列命令、日志、退出及 clean/failed 分账。通过的候选拒绝刻画不表示候选已确认或产品已修复；现有 duration 六项测试只证明 formatDuration 的范围，intl 没有独立运行验证。

全历史查重覆盖 prior docs/bugs **1,088 Markdown + 680 parsed JSON = 1,768 文件**，含 archive/_archive、排除本批，解析错误 0。Root/Web/Bytes 为 185,197 JSON 字符串叶，Utils 为 260,285 scalar leaves；口径分开。已有 Codex 输出、ANSI border、字节标签等相关记录排除，没有恢复旧失败方向。

[基线变化](baseline-refresh.md) 记录 main 开审前新增的八个其他任务提交。DESKTOP-R12-01 与 ATT-R9-01 的直接实现已有源码改动；本批仅核对 diff，未重跑旧问题实验或独立验证它们的 UI/native 修复效果。[已变化旧源](addressed-sources.json) 将此状态与本批新问题计数分开。

[findings](findings.json)、[candidates](candidates.json)、[related](related.json)、[source pins](source-manifest.json)、[worker integrity](worker-integrity.json) 和 [evidence index](evidence-index.json) 汇总可核对材料；[assembler](evidence/assemble-audit.py) 仅处理元数据。导航猜路径/材料未就绪诊断均明确转录；后续按已保存 receipt 的实际指针读材料属于元数据定位，不恢复产品失败方向。只读交叉复核与最终 QC 一并归档。

未执行真实模型/收费 API/账号/用户数据/网络/socket/上传/实际图像解码器/React/Ink/DOM/Electron/native/终端/TTY/PTY/真实自动化/外部消息/权限安全custody实验；没有 shared deps/dist 重建或完整 build/typecheck/lint/suite 结论。

[整合前核验](evidence/integration-plan.json) 记录末尾 fetch 已完成、current main 仍等于本批冻结源；62 个 selected source/contract pins 当前字节一致，45 个 worker artifact hashes 已核对。主工作区既有 tracked deletion 与四个 untracked 文件的状态/字节/hash 与开审快照相同；只允许本批目录 disjoint fast-forward，前后继续核对。当前独占 worktree 继续用于持续审查。
