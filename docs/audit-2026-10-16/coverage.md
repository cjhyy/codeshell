# 覆盖与验证边界

冻结源码：`66ee7737a7d6203319834e601c84afe6757f801e`；工作分支 `codex/audit/full-repository-20261016`。起点从最新已抓取 `origin/main` 创建，再 fast-forward 到当前本地 main（当时比 origin/main 多 53 个提交），因此审查的是用户当前本地版本，而不是较旧远端版本。其他任务的 worktree 和主目录预存改动未参与修改。

本轮从项目规范、目录库存和当前源码开始。旧 `docs/review-*` 只用于有限查重；没有把旧报告的全部条目自动当作当前缺陷。逐项问题均标明是否已知、动态复现还是静态确认。库存见 [inventory.json](inventory.json)；其中 source 文件计数仅按扩展名/文件名计算，包含一些脚本与 fixture，不代表产品模块数量或逐行审查数量。

| 包/范围 | 本轮审查深度 | 动态验证 | 主要未覆盖 |
| --- | --- | --- | --- |
| Core | run open/finalize/accounting、goal、executor/permission、provider 流收尾、Session CAS/fork/merge、history hooks、Cron、auxiliary 初读 | 6 个聚焦测试；与 Host/Pet 合并的 135 项既有 baseline | 全 builtin、operations、plugin/sandbox、MCP 所有恢复分支、完整 journal repair、真实模型 |
| Host | 请求分发、rollback、capability activation/lifetime | 同上 baseline 中 HostRuntime/ask-user | 所有 worker/进程异常及跨平台路径 |
| Pet | projection、manager/followups/route、visit receipt | 同上 baseline 中 index/validator/route/receipt | 真实 IM、Desktop 持久 store 与完整 pet 工作流 |
| Coding | ApplyPatch 计划/提交/rollback、Git/worktree、Notebook、DriveAgent 接线、LSP、外部 runtime/history/discovery | patch/Git 7 个新测试；Coding Git/patch + Arena/Optimization Lab 253 项 baseline；runtime shared 的 TUI 合并 baseline | 真实 Codex/Claude/LSP、所有 DriveAgent 并发/退出边界；Notebook 旧问题本轮只读未重跑 |
| TUI | CLI run/runs/options、slash commands、permission、undo/export、renderers、query guard、输入/history、pending question | 5 个新测试；150 项 CLI/UI纯逻辑等 baseline | 完整 Ink/PTY 原生会话、全部组件渲染与快捷键 |
| Desktop | 文件/图片/附件搜索、Panel package/bridge/resource、browser driver/native decoder、PTY接线、media custody、history conversion、renderer hooks/mobile/Cloud 接线 | 文件搜索 3 项、decoder 3 项；均局部，不是 Electron E2E | 大量 renderer 组件、完整原生App、真实Chrome/OS事件、Panel全方法和native tools |
| Server | mobile remote、Hub auth/files/uploads/replay/approval、session catalog、headless lifecycle、Link接线 | 首次 121 pass + 1 缺dist环境失败；仅构建本worktree server后单文件 11 pass 补证；catalog新3项 | 全 Server suite 未整体重跑；真实公网、Docker/tunnel、长期恢复 |
| Web | socket/reconnect、输出journal、approval/auth/api scope、Panel upload/polling/environment | 121 项 baseline | 完整浏览器/手机E2E与所有React组件状态组合 |
| Chat | queue/gateway/lifecycle/ingress/config、adapter factory、各主要渠道的消息路径 | 71 项 baseline；新6项（账号/附件4、Matrix2） | 真实平台ACK/消息/账号、未抽到的各adapter分支 |
| Link | 合约、browser handoff、OAuth broker/service、operation/runtime接口 | 与CDP/devtools合并104项baseline；Server Link HTTP补证 | 真实账号/授权/外部provider全生命周期 |
| CDP / browser-devtools | helper/inspector和生产消费接线 | 合并baseline同上 | 真实浏览器与全站点适配 |
| Arena | retained私有源码的provider/context/iterate/convergence/state，Host不加载 | 253项合并baseline中的Arena测试 | 完整真实多模型讨论/审查，不以私有源码问题外推生产Host |
| Optimization Lab | metered fetch、lease/store/canonical JSON、预算/停止/overfit | 253项合并baseline中的Lab测试 | 真实优化模型/实验、全故障注入和所有输出画面 |
| 根脚本 / CI | release/publish/copy/meta/test guard/版本与门禁接线 | 42 项既有测试；20条workflow测试路径、engine bypass guard通过 | 全包clean build/typecheck、package-release打包门禁、真实发布/自动更新 |

各行共享的 baseline 不能重复相加。以 [validation.json](validation.json) 的每次运行分账为准；初次失败、修支架后重跑和旧收据都保留。测试通过表示观察与断言一致，包括对 bug 的断言，并不表示产品已修复。

新 worktree 的第三方依赖通过软链复用本地安装；workspace public imports 在一些既有测试中可能仍指向主目录已构建 dist。聚焦测试尽量相对导入冻结源码；所用边界替身在分报告中说明。本轮仅 Server 因单个 native case 的导入需要做了局部构建，不能把它等同全部依赖的 clean build。

范围限当前 CodeShell 仓库。独立 `codeshell-panel-apps` 仓库的业务实现、ignored 个人资料/运行状态、node_modules、已有外部 worktree、真实外部账号和付费模型不属于本轮代码审查输入。文档/示例/配置做库存和契约参照，没有逐篇检查全部历史文档与生成资源。

本轮没有承诺所有文件逐行覆盖，也无法证明不存在其他 bug。继续审查应从表内未覆盖路径和 [候选表](candidates.md) 逐项建立证据，而不是把“已运行若干测试”解释为“所有内容已审完”。
