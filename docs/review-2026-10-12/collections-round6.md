# Collection 跨文件查询与失败恢复，只读复核

快照：`a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。比较范围 `84740d56..HEAD`。未修改产品、未自行构建/清理 dist；只在主代理确认构建成功后读取新 dist。

## 已验证的 P3：新接入的共享资料集跨文件查询丢失可恢复的子错误

主要位置：`packages/core/src/tool-system/builtin/sources.ts:470–473`；新增可达入口 `:595–602`。

用户通过 Desktop 资料集选入两个普通文本原件，并将两个文件 scope 绑定到项目后，正常在编辑器中修改其中一个原件；下一次对这两个文件发起 `ReadSource({ source, resources: [{scope, resource}, ...], query })`。Collection 的原件检查正确拒绝旧版本，但 corpus 层将真实子读取错误统一替换成：

```
Error: collection query failed: A selected document read was denied, failed or produced no trusted receipt
```

同一个已修改文件的单文件 `ReadSource` 会明确返回：

```
Error: read failed: Collection file changed since selection; update the collection before reading
```

跨文件结果没有指出哪个 scope/resource 失败，也没有保留“请更新资料集”原因。实测用户拒绝最后一个文件授权时，也收到完全相同的 corpus 错误。因此助手/用户不能从这次失败判断应重新授权还是更新哪一个原件；需要额外逐项试读或退出对话检查资料集。这是恢复信息缺失；原件变更应被拒绝、任一失败应不返回部分 corpus 都符合明确设计。

### 生产接线与实际证据

- Desktop 配置入口：`SourceCollectionsSection.tsx` 创建/选择原件并显示条目；项目 sources binding 通过 Main `sources:bindProject`（`main/index.ts:3726`）写入真实 binding。
- 新跨文件入口：`sources.ts:595–602` 允许 `access.kind === "collection"` 进入 `querySourceCollection`；逐项 `executeBoundTool(ReadSource)` 位于 `:453–466`。
- 子读取：`sources.ts:662` → `readCollectionDocument` → `readCollectionLocalFile`，正常原件变更产生准确的更新指引（`collection-local.ts:153–168`）。
- 丢失处：`sources.ts:470–473` 不区分 `result.isError` 与缺失 receipt，也不保留可信执行结果的 error 或 selection。
- 对话通道：真实 compiled `Engine` fixture 的 `onStream` 仅收到父请求 `round6-corpus` 的一条 `tool_result`；下一轮 deterministic client 输入也仅有相同笼统父错误。子读取可能进入内部日志/hooks，但没有另行发送给对话。生产 TurnLoop `turn-loop.ts:1667–1691` 只记录/发送外层 drain 返回的结果。
- 正常恢复对照：调用实际 Desktop `createSourceCollectionService.update(kind:"refresh")` 后，修改的 entry ID 保持不变、状态 `changed → ready`、hash 更新，再执行同一 corpus 查询成功返回两个匹配。

差异边界：笼统错误分支在 `84740d56` 的 uploads-only corpus 实现已存在；本次新增共享 Collection 跨 scope 查询复用了它。旧基线 `readSourceTool` 明确拒绝 Collection 的 `resources` 参数，故“共享资料集原件编辑后跨文件查询丢失恢复原因”是本次新增可达路径。若只接受全新错误分支，可将此项归为已验证改善项，不宣称字符串本身是新写。

主审采纳为 R49/P3，范围限定已知本地原件变更的安全恢复诊断。保持任一失败终止 corpus、不返回部分正文；可返回错误类型、已选择的 scope/resource 和更新资料集指引。不要无条件把任意子错误原样暴露给外层。

## 正常和失败对照

自定义 `recovery.test.ts` 由仓库 guarded runner 运行，4 tests / 32 expectations / 0 failures：

1. 真实 compiled ToolExecutor、真实 Collection adapter、虚构本地原件：成功查询 → 编辑原件 → corpus 拒绝、单读给出具体恢复原因 → Desktop service 更新检查 → 同 ID 查询恢复。
2. 每文件授权：最后一项拒绝时没有部分 corpus；下一次逐项允许成功，无残留拒绝状态。
3. 真实 compiled Engine + deterministic in-process client：确认流式对话和下一轮输入不含子失败原因/失败 scope。
4. Desktop service revision 冲突：旧 revision 保存拒绝、不覆盖另一窗口的新值；get 后用新 revision 保存成功，原件选择 ID 保留。

现有 `sources-collection-query.test.ts` + `collection.test.ts` guarded shard：65 tests / 374 expectations / 0 failures。覆盖 metadata/size/deny 前置检查、Profile/binding/pin/revision 变化、逐项审批、URL 最终重下载与顺序一致性、取消、时间/容量预算和稳定引用等。

## 排除项与测试边界

- Collection scopes 是合法 manifest 的纯 metadata 投影；“编辑绑定 scope IPC 失败后允许保存空 scopes”未找到稳定正常触发，未列发现。
- URL 下载在 DNS 前调用 `reserveInputBytes(0)`，已排除“DNS 等待未恢复 corpus 计算预算”疑点。
- parser cache key 已包含 `documentName`，未发现同 ID/同 bytes 改文档名导致错误复用 parser 格式。
- 无 OCR、无语义/embedding、最多 8 文件、顺序远端再验证、拒绝时无部分结果、显式更新原件版本，均为本次明确交付边界，不列 bug。
- 自定义 fixture 只创建虚构原件与隔离应用状态；不是完整 Electron 点选 E2E。Desktop native picker/reference callback 是 fixture，保存、版本捕获、binding、真实 service refresh/CAS、Core 查询和 Engine 流水线是生产实现。
- Engine client 仅返回预设的本进程响应，没有外部 API、真实模型或付费请求。
- `fetch/http/https/net/tls` 10 个列举 JS surface 在 Core 导入前安装拒绝 guard，5 个负向探针，最终意外网络请求为 0。guard 不是 OS 网络沙箱。HOME、应用状态由仓库 runner 新建，未读取操作者凭据；临时原件/状态在每项后移除。

证据：`recovery.test.ts`、`recovery.log`、`recovery-observations.json`、`existing-query.log`。observations 包含快照、进程/运行时、HOME/可执行文件 hash、生产 dist 文件 hash 与实际结果。

复现命令：

```
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-collections-round6/recovery.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/tool-system/builtin/sources-collection-query.test.ts packages/core/src/sources/collection.test.ts
```
