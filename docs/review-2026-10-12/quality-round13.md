# 第十三轮收束与独立复核

本轮新增 **R58/P2、R59–R62/P3**，正式总数 **62 = 1 P1 + 44 P2 + 17 P3**。六个新增通用文件在初始 84740 与冻结 a66f 两基线分别完成 **48 测试、304 断言、0 fail/skip**。其中 catalog-protections wrapper 导入的 33 个既有保护测试只计一次；本轮质量复核只读，没有额外运行计数。当前通用总数为 58 文件、186 测试；最新功能专用仍另计 3 文件、8 测试。

| 发现 | 独立核对与裁定 | 必须保留的范围 |
| --- | --- | --- |
| R58/P2 合法工作区终端 | automation_flow_review 检查正式 workspace switch、文件权威、PanelArea/Registry 与现有 Terminal workspace 契约，支持保留；详见[多窗口附录](multiwindow-round13.md) | 管理的 Session worktree 不等于已注册 project root；拒绝发生在 native PTY 前。Primary/secondary 正常、任意目录拒绝、切回 main 恢复均动态验证。不能以 terminal 句柄充当 engine session 权威 |
| R59/P3 首提交 Review | review_quality_audit 检查菜单实际列出最近20内root、无父 range、catch 空串与 viewer；见[独立复核](terminal-review-quality-round13.md) | 实际 service/viewer + 自有Git；完整菜单/Main仅接线核对。第二提交正常不修复root；手动 diffText 是正常对照，不是现有恢复按钮 |
| R60/P3 侧栏删除失败 | automation_flow_review 检查实际确认、持久diff、同键墓碑及SessionsView；见[独立复核](session-actions-quality-round13.md) | “永久”限定同project/local-row键的tombstone。实际 Core state/transcript保留；历史页修复权限后可重试完成删除。完整Main前置close/cleanup未动态运行 |
| R61/P3 同项目双窗口选择 | web_remote_review 独立查正式New Window、窗口独立activeProject与共享activeSession、字段更新及去重，支持保留 | 未找到要求镜像导航的产品契约，按确定的流程摩擦列P3。真实store/IPC/preload/双persistence + 精确AST选择链；未运行完整Electron双窗、真实发送或附件保护 |
| R62/P3 离开CLI残留审批 | root 读取实际hook/controller/按钮回调fixture与生产leave/门禁，支持独立保留；见[生命周期附录](web-lifecycle-round13.md) | 离开前已有普通Read审批才触发，无卡leave及迟到旧卡均正常。卡仍指向A，不是错误发给B。重选native已验证；新建与正常resolved恢复仅静态 |

R60 原候选 W23，R62 作者也临时使用 W23；正式将后者改称 W24，防止混同。R61/M1 与 R16 的 CC viewer 广播、归档 I11 的 worker 输出广播不同；它来自普通 project catalog activeSessionId 的跨窗口投影。R60 与 R24 的项目权威提前删除、R57 的 orphaned 下载关闭遗漏不同。R62 与 R10 的待审批快照缺失方向相反，修复应协调，但不是同一个触发条件；也不依赖 R11/R19 的发送失败或 R14 的可选 async 问题。

R61 的“目录共享”有明确实现意图，不能仅因共享就称持久数据错误。被报告的是两个正式窗口无法稳定各留在同项目不同会话。文本稿按窗口内 bucket map 保存有源码保护，本轮没有运行实际文本/附件发送，因此不把它扩大为数据丢失或错发。用户重新选择可恢复，但会同步影响另一个窗口。

本轮未将未经实证的 live diff 大文件渲染预算、HTTP session-list 刷新时序、mock socket 人为不可能乱序或单窗口关闭缺少全局flush列为问题。继续遵守 review 范围：产品未改、无发布、无付费模型或真实账号。

代理原始报告和日志在 `/tmp/codeshell-review-20261012-*-round13*`；便携复制修正硬编码 repo/evidence 路径与旧snapshot标签，补 guarded HOME 断言后两基线逐文件运行。代理初始日志保留在 `validation/original-*-round13/`，正式完成日志在各 reproductions 目录和 latest archive。归档日志只统一行尾空白，不改测试结果；原 `/tmp` 日志未动。
