# Web 配置 / Skills / MCP 第二轮审查

基线：`84740d56e55517b004948a0a0e07649ad6fbf998`。

产品工作区：`/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`。本轮未修改产品文件。下面路径均相对此工作区。

生产入口：Hub `packages/web/app/App.tsx:14-19` → `Workbench`；桌面配对移动端 `packages/desktop/src/mobile/main.tsx:4,14` → `DesktopApp` → `Workbench`。共享工作台 `packages/web/app/Workbench.tsx:851-861` 真实挂载 `HubSettings` 并传入配置版本和草稿导航门禁；`HubSettings.tsx:57-67` 挂载 Skills/配置页，`HubSettings.tsx:231-236` 挂载 MCP。下列问题均在这些实际组件复现，未使用旧移动 App。

验证：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-round2/settings-review.test.tsx
```

最终结果：**3 pass / 0 fail / 0 skipped / 23 assertions / 977ms**。

脚本：`/tmp/codeshell-review-20261012-web-round2/settings-review.test.tsx`；日志：`/tmp/codeshell-review-20261012-web-round2/settings-review.log`。采用真实 React DOM 组件、生产 HTTP handler、guarded runner 隔离 HOME；Core-facing import 前封锁网络，只放行每个测试新建的精确 loopback origin。W7 使用完整 `startHeadlessServer`、全新测试账户认证和真实 `withConfigurationMutation` 门禁，服务器处于合法的首个任务前状态（无驻留 worker），第二个已构造的请求在第一个响应返回/门禁释放后才放行至主机。MCP 专项全部请求使用 fixture，不运行实际 MCP 命令。没有发送模型请求、访问用户账户或用户服务。

## W7 — [P2] 两个已打开的默认模型表单先后保存，会静默回滚未修改的另一项

- 精确定位：`packages/web/app/HubSettings.tsx:669-674`，辅助字段无论是否被用户修改都随对话字段一并发送；`packages/server/src/hub/configuration.ts:213-232` 无 revision/原值比对，直接覆盖两个有效默认值。
- 触发：两个设备/标签页均从 `{text:one, auxText:one}` 开始，A 只把对话模型改为 `two`，B 只把辅助模型改为 `three`；在任一保存通知/刷新抵达另一端前，两边都已生成保存请求。A 请求为 `{text:two,auxText:one}`，B 请求为 `{text:one,auxText:three}`。A 先完成写入并释放配置互斥门禁；B 的请求随后到达服务器，仍携带旧 `text`。
- 实测：完整认证 Hub（真实配置门禁）先后接受两次写入；两端 UI 都显示“设置已保存”；最终为 `{text:one,auxText:three}`，A 已保存的对话模型被 B 没有操作过的旧字段静默回滚。反过来的写入顺序会回滚 B 的辅助模型。`DefaultModels` 的外部刷新保留逻辑能处理已到达的快照，但无法改写已经发出的旧请求。
- 限制核对：`packages/server/src/serve/headless-server.ts:541-582` 在首个配置变更及 worker 热重载仍进行时，会用409拒绝同时到达的另一个请求；因此本条不是两个事务同时运行。复现显式等待首个响应后才放行第二请求，对应独立标签页/网络中第二请求较慢、且另一端尚未接收配置快照的合法顺序。即使 worker 存在，第二请求在重载完成后才到达也满足相同条件。
- 影响：跨设备修改不同默认项仍丢失更新，后续任务使用错误的对话/辅助连接。无需断网；两端同时操作即可。
- 建议：为默认配置加入 CAS 并提供冲突恢复；或仅提交明确修改的默认字段，让服务器在锁内合并。连接编辑现有 revision 保护可作为一致的交互参考。
- 测试缺口：现有默认设置测试验证单次修改/跟随主模型，未覆盖两个已打开页面的旧快照请求跨越配置门禁后顺序提交不同字段。专项用两个真实 `HubSettings` 和完整认证隔离 Hub 验证。
- 信心：高。日志 `DEFAULT_CONFLICT` 保留精确请求与最终值。

## W8 — [P3] Skill 保存冲突后，“刷新”不能恢复保存能力

- 精确定位：`packages/web/app/HubSkills.tsx:86-101` 刷新只替换列表 `snapshot`；编辑面板继续持有原 `pane.detail`（`:257-265`），每次保存固定使用 `detail.revision`（`:505-515`）。
- 触发：A 打开现有 Skill 并编辑 Markdown，B 先保存同一 Skill。A 保存得到真实服务端 409“Skill 已发生变化，请刷新后重试”；A 点击页面“刷新”，再保存。
- 实测：刷新后错误消失且草稿保留，但第二次 PUT 与第一次仍携带同一旧 revision；真实服务端继续返回409。列表中的新 revision 不会传入编辑面板。测试保存了两个完全相同的旧 revision 与不同的当前 revision。
- 影响：页面给出的“刷新后重试”恢复路径无效，用户无法在当前编辑流程完成保存；只能复制草稿、关闭并确认放弃、重新打开、手工重贴和核对。草稿没有被自动丢弃，因此列为流程恢复 P3。
- 建议：冲突时明确展示已过期状态，并提供读取最新内容、检查差异和保留草稿的恢复操作；不要仅清掉错误而维持不可保存的旧基线，也不要自动更新 revision 后无提示覆盖他人内容。
- 测试缺口：没有覆盖409后通过页面刷新再次保存。专项用真实 `HubSkills`、真实文件 revision 和真实隔离 Skills handler 验证。
- 信心：高。日志 `SKILL_CONFLICT` 保留两次尝试的 revision、当前 revision、草稿保留状态。

## W9 — [P3] MCP 旧测试响应晚于配置刷新时，会为新配置显示旧的测试成功

- 精确定位：`packages/web/app/HubMcp.tsx:183-186` 接收 probe 结果时仅检查 mounted/abort；配置刷新 `:103-120` 没有取消或隔离旧 probe，其清理结果只影响当时已经存在的 results。
- 触发：A 测试 `old-command`；主机完成测试，成功响应在网络中延迟。B 把该服务改为 `new-command`，A 收到配置变更并刷新成功。随后 A 才收到先前 probe 响应。主机上 probe 已结束，因此 B 修改时的服务端 cancelServer 不再能撤销已经发送的响应。
- 实测：真实 `HubMcp` 刷新后卡片显示 `new-command`；释放旧响应后，同一卡片显示“测试连接成功”及 `old_command_tool`。旧结果的 checkedAt 明确早于此次刷新开始，仍会被后来的 setResults 写回。
- 影响：用户误以为刚更新的 MCP 命令/地址已通过测试，并根据旧工具列表判断新配置可用。这是状态误导，未发现因此直接执行旧工具，列为 P3。
- 建议：probe 捕获配置/服务版本或请求代次，刷新后忽略不再对应当前配置的结果；也可在配置变更时取消本地 pending probe 并要求重新测试。模型连接页已经会在 connection revision 改变时中止 probe，可统一规则。
- 测试缺口：未覆盖成功响应延迟与配置刷新交叉。专项使用真实组件和受控延迟 fetch response，不执行 MCP 命令；服务端 cancelServer 生命周期已静态核对。
- 信心：高（客户端顺序为确定性复现；传输延迟条件为常见竞态）。日志 `MCP_STALE_PROBE` 保留显示命令、实际被测命令和旧工具名称。

## 已核验但没有提交为缺陷的路径

- 模型连接更新/删除有 revision/CAS；草稿在外部刷新或连接外部删除后仍保留；取消修改有显式放弃确认。
- 删除最后一个文字连接会清掉对话/辅助默认，删除当前默认且仍有连接时要求替代连接；服务器同时校验替代连接。
- MCP 编辑发送显式字段 patch，未修改字段不会因刷新覆盖另一设备；服务端拒绝编辑已删除服务，不会被误复活。
- 历史标题重命名有 expectedTitle 和读取最新标题恢复；后台搜索/分页/目录和文件预览均检查 abort 信号。历史归档不会清空正在编辑的标题草稿。
- Settings/Skills/History 的导航草稿门禁和 beforeunload 在共享 Workbench 实际接入；显式取消、尚未安装的 GitHub 导入输入丢失未提升为正式发现。
- 手机媒体查询具备主要表单单列/换行处理；本轮未做实体触屏/软键盘视觉验收，不将仅靠静态 CSS 猜测的布局问题列入发现。
