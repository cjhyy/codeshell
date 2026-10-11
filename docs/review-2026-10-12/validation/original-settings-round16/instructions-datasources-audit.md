# 第十六轮 ProjectInstructions / DataSources 只读反证

冻结 a66f4ef291f304ee4df9da8095a90671d9a8f140。已读 CODESHELL.md、主报告 R01–R68 与 flow-coverage，重点对照 R25/26/27/28/R49。新增测试与实验执行 **0**，产品/主报告/goal 未改；仅写本文，没有再委派。

## 结论

本次没有新增正式缺陷。保存后继续完成原项目的已提交操作，与旧响应污染当前项目不同；现有组件和 Main 的项目身份保护足以排除后一类泛化。ProjectInstructions 是外部编辑器入口，不是内置文本保存表单；不应套用主扫的 debounce 保存结论。

## 项目指令

- 正式入口 SettingsPage.tsx:735–741 明确传 scopeProject.id、primaryRootId、path。ProjectInstructionsSection.tsx:64–90 每次 cwd/projectId/rootId/重试换代，清旧状态，Promise.all 检查的成功/失败/finally 都核对 targetVersion；卸载使版本失效。
- ProjectInstructionsSection.tsx:92–113 同步 openingRef 防重复，动作捕获当前 targetVersion；旧打开完成后不会继续查新项目，旧拒绝也不写新错误或解锁新操作。206 的 disabled 与 93 的真实 handler gate 均存在。
- 这里 99 仅调用 openInEditor(fileName,cwd)，之后 101 重新检查文件存在；没有 save/delete 指令正文。Main index.ts:6415–6420 检查有界路径并通过 requireRendererProjectPath 验证 cwd；desktop-services.ts:889–908 将相对路径固定解析到捕获的 cwd，再尝试外部编辑器候选，全部失败抛错。打开旧项目外部编辑器已经是用户提交的操作，离开组件不等于承诺关闭该编辑器或撤回其保存。
- 检查失败保持未知且禁用文件动作，144–150 显示错误；130–142 可重试。打开失败在 104–111 恢复操作并在 227–235 显示逐文件错误。没有“加载失败当文件不存在立即创建”的路径。
- 既有 ProjectConfiguration.interaction.test.tsx:179–195 核对检查失败/重试且无打开；197–214 核对去重、打开失败、重试；216–229 明确核对旧项目 pending editor 失败不污染新项目。仅只读既有源码和已有 baseline 通过收据，未重跑。

## 项目数据源

- DataSourcesModule.tsx:16–19 项目 scope 明确传 projectId。DataSourcesSection.tsx:59–65 内部 ProjectDataSources 以 projectId 为 key，切项目重挂 fresh form；100–107 layout cleanup 同步 active=false 并增加 load/scope request 世代。
- DataSourcesSection.tsx:109–131 的 refresh 绑定捕获 projectId，并要求 active 且 request===loadRequest 才写 catalog/snapshot/error/loading。167–198 的 scope 查询有独立 scopeRequest，切源/取消产生新世代，旧查询成功、拒绝和 finally 均不能覆盖新选择。
- 保存不是自动 debounce：564–588 显式点击调用 bindProjectSource(projectId,{sourceId,scopes,readPolicy})。137–165 的 act 在任何 await 前占 busyLock，重复 handler 不会双提交；成功必须仍 active 且 refresh 成功才清 selection/成功 toast；失败保留表单并显示 error，再释放锁。busy 时按钮/选择有 gate。
- 596–605 取消调用 selectSource("")，169 增加世代并清选源/范围，178–180 结束 scope loading；不调用 bind。离开/切项目时尚未提交的选择由重挂释放。已提交的 Main 操作可能继续写原项目，这是捕获身份，不是偷偷写到新项目。
- 删除上传的 315–330 等待 themed confirm；325–326 明确要求 accepted 且 active，取消或旧项目卸载后迟到同意不会写。解绑 410–421 使用显式项目/源 ID，经过同一 act single-flight。
- Main index.ts:3722–3760 所有项目读/绑定/解绑/上传/删除均先 requireRendererProjectPrimary(projectId)，固定捕获 Main 权威的 path，未从 renderer 随意传 cwd。上传 3747 先解析 path 再开 picker；3752 cancel/空选择返回[]，否则写捕获的原项目。切项目不会把迟到文件选择写入新项目。
- sources-service.ts:110–115 为目标 cwd 新建 full SettingsManager；core sources/binding.ts:24–26 验 schema，从当前磁盘 settings 读取其余 bindings，按 sourceId 替换一个条目并只写 sources 字段；29–31 解绑也从当前列表过滤单项。没有将初始 UI 整份旧配置直接回传覆盖所有设置。因此不能把 R25 的完整模型表单回滚或 R28 的初始化空禁用列表问题直接复制为数据源发现。相同 sourceId 并发显式修改仍是独立并发语义，本文未验证，未列问题。
- 既有 SourceCollections.interaction.fixture.tsx:493–499 覆盖旧项目 snapshot 拒绝覆写；517–523 覆盖旧 scope 回包；535–549 覆盖同 tick 双保存只调用一次；550–553 覆盖保存中切项目后无旧 toast。DataSourcesSection.test.tsx 既有绑定/解绑/上传/删除正常用例亦在 baseline 收据通过；未新增执行或重复计数。

## 边界与不列项

Main 文件 picker 取消返回[]后，当前 act 仍会刷新并显示 uploadDone 文案（285–287、147–158）。这是静态上的取消反馈不精确；没有实际上传或跨项目写入证据，本文不将其升级为正式缺陷或安全问题。若主扫需要可另用真实组件+受控 picker 验证文案，但不应把它计为数据丢失。

DataSources 首次 refresh 失败后仍允许显式重试动作/选择，旧 authoritative snapshot 未被伪造成成功；此处不宣称所有读取损坏与跨窗口 CAS 全面无问题。R26 Skill revision、R27 MCP probe 与 R49 Collection 原件更新指引各有独立正式根因，本审计未新增同类编号。本文只是上述源码路径与既有收据的只读反证，不等于本轮已动态执行或完整原生外部编辑器/picker 验证。
