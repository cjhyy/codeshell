# 资料集跨文件词法查询

2026-10-11。复用已发布资料集和 `ReadSource`，在同一资料集内查询明确选定的多个文件；本次源码增量尚未发行。不新增侧栏、第三方账号、同步服务、OCR 或语义检索。

## 输入与来源引用

资料集每文件各有独立 scope。先从 `ListSources` 取得实际可见的 ID，再明确指定 1..8 个唯一 `(scope, resource)`：

```json
{
  "source": "library",
  "resources": [
    { "scope": "entry_a", "resource": "entry_a" },
    { "scope": "entry_b", "resource": "entry_b" }
  ],
  "query": "项目预算",
  "limit": 5
}
```

资料集模式省略外层 `scope`，与 `resource`、`chunk` 互斥，不接受混合字符串、重复项、额外 source、通配符、目录、跨资料集／项目选择或隐式全部文件。当前 manifest 每文件的 scope 与 resource ID 相同；实现仍逐项核对该 scope 的实际 metadata，不据 ID 相似性推断授权。

既有 uploads 的 `source` + `scope` + `resources: string[]` 以及单文件 `scope` + `resource` + 可选 `query` / `chunk` 保持兼容。资料集查询使用同一个词法 corpus 和词频权重，按分数及固定 UTF-16 的 scope/resource、原文偏移稳定排序，不受选择顺序或 locale 影响。不是 embedding 或语义检索。

结果 `resources`、`matches` 均带实际 `scopeId` 与 `resourceId`、原件 hash 和 parser version；命中另带已有 chunk ID、原文部分及偏移。使用返回的 `scopeId`、`resourceId` 和 chunk ID 可经原单文件 `ReadSource` 精确复读当前版本。原件变化时先阻断读取并要求显式更新资料集；内容 hash 改变后旧 chunk 失效。

## 逐文件授权与真实回执

第一次正文读取前先核对全部选定 scope/resource 的 metadata、Profile 与项目 binding 求交、当前 Session pin、显式 deny、集合 revision 和已知总输入大小。metadata 与 permission preview 不批准读取正文。

随后按稳定顺序逐文件调用现有 pinned `executeBoundTool(ReadSource)`；每份文件实际通过 permission、原生审批、Hook、工具开关和 Run allowlist。子调用的 scope/resource/query 被 Hook 改写时不能交付可信回执。最后一项拒绝或失败、撤权、取消、原件变化和预算超限均使整个 corpus 查询失败，不返回部分集合结果。此前已批准的单文件读取仍可存在于其独立审计记录中，不承诺将已发生读取回滚。

真实 collection adapter 从实际本地／URL 字节构造 index 和原件重验闭包。父查询通过 executor-owned 的私有 Symbol sink 接收 typed receipt；不从工具 JSON、Hook 结果或附加 prose 创建来源证据。不可信文本仍经既有秘密脱敏和 untrusted marker 包裹。无新增稳定 SDK 入口。

## 本地与 URL 的最终检查

本地文件在实际读取前占用输入预算，保留选定版本的 realpath、dev/ino、大小、mtime 与 SHA-256 检查；本次查询还固定原件父目录 dev/ino。同字节文件替换，以及保留原文件 inode 的父目录替换，都不能复用旧 receipt。

URL 初次读取仍使用既有无凭据 HTTPS transport、公共 IP/DNS 检查、TLS 验证、同 origin 重定向和 20 MiB 限额。最终返回前，每个选定 URL **实际重新下载**并核对保存的 hash/大小，以及本次解析所见 final URL/MIME；不以缓存、ETag、metadata 或本地闭包冒充远程版本检查。

这些 URL 检查是顺序观测，结果明确返回 `remoteConsistency: "sequential_revalidation"`。远程内容可能在某次观测后继续变化，多 URL 不是同一时刻的原子快照。全部 URL 检查完成后，无 await 地同步重验所有本地原件及当前权限、Session pin、项目 binding、集合定义/revision 和单调时间预算，再返回结果。

## 预算与验证边界

沿用每份原件 20 MiB、选定原件输入合计 40 MiB、冻结 index 合计 4 MiB、集合 JSON 正文 256 KiB 和累计计算 30 秒。URL 在接受正文前依据 Content-Length 或逐 chunk 占用实际输入预算；审批和 pre-start Hook 等待暂停计算预算，实际本地读取／URL DNS 与下载前恢复。每次最终 URL 下载仍受单文件和共用取消／时间预算约束。

40 MiB 是不同选定原件的输入限额，**不包含原件重验和最终 URL 重新下载的重复磁盘／网络 IO**；也不是 OS RSS 上限。解析仍用既有独立 worker、并发／排队限制和有界进程内 LRU，不建立共享的派生磁盘索引，不后台扫描未选文件。

源码回归使用隔离 HOME 的 guarded runner、真实 ToolExecutor/permission/Hook 与真实解析 worker，覆盖两项目复用、Office/CJK、统一评分、chunk 复读、逐项拒绝、Hook 改参、Profile/pin/permission/binding/revision 变化、文件／目录替换、URL 最终变更和预算／取消。URL fixture 在首次 Core 导入前安装明确 JS API 禁网 guard，使用精确合成 origin 的 TLS/HTTP 事件执行生产 downloader，并核对两次真实逻辑下载及关闭；不代表真实公网、网盘账号或 OS 级网络隔离。编译后 SDK、完整构建和组合 CI 的最终证据由本次集成交付记录补充。

当前源码验收：新增 51 项 / 308 次断言，既有 uploads／单文件／资料集／URL／parser index 回归 127 项 / 955 次断言，均零失败、零跳过；修改的 TS 文件通过 targeted ESLint。将同一个跨 scope 两项目用例放入 `84740d56` 的隔离归档源码后，真实旧 ToolExecutor 以旧 schema 缺少外层 scope 拒绝，当前实现通过。

2026-10-12 集成本地验收：Host 与资料集组合回归 103 项、562 次断言，零失败、零跳过；9 个发布 tarball、47 个类型入口及 45 个运行入口检查通过，12 个 workspace 类型检查和 Desktop 构建通过。ESLint 零错误、105 项既有基线警告。

新增 `bun run test:collection-documents` 使用编译后的同树 SDK / ToolExecutor、真实 Engine 和独立解析进程，验证两项目复用、父查询及逐文件审批、稳定排序、逐 chunk 精确复读、显式拒绝、同内容 inode 替换拒绝，以及冷 Node 进程重新读取。实际运行于 Node 25.8.1 与 Electron 对应的 Node 20.18.3，既有 uploads 编译 SDK 验收及 Core 导出检查也通过。使用合成模型回复和受控本地输入，没有真实 provider 调用；这些进程验收不等于原生 Electron UI 验收。完整 CI 与主仓库合并状态另由本次 PR 记录，尚未新增发行版本。
