# 上传文件跨文件词法查询

2026-10-09。复用既有项目上传入口和 `ReadSource`，不新增侧栏、工具或全项目默认授权。此增量晚于 v0.9.29 冻结源，发布状态以正式发行记录为准。

## 使用流程

先用 `ListSources` 查看 metadata，再明确选择同一个 `project-uploads` / `uploads` 中的文件：

```json
{
  "source": "project-uploads",
  "scope": "uploads",
  "resources": ["brief.docx", "notes.md"],
  "query": "项目预算",
  "limit": 5
}
```

`resources` 为 1..8 个唯一、精确、已列出的 resource id；与原 `resource` 和 `chunk` 互斥，必须带 `query`。不接受通配符、目录遍历、隐式全项目扫描、跨 scope/source/workspace 选择。单文件读取、单文件查询与分块引用仍兼容。

结果为受不可信内容标记包裹的 JSON。`search: "lexical"` 明确表示本地词法检索，不是语义检索、embedding 或 OCR。所有已选文件的分块共用同一 corpus / 词频权重；按分数降序，再按 resource id 的固定 UTF-16 顺序、原文部分/偏移排序，选择顺序与主机 locale 不改变并列顺序。

`resources` 列出每份实际原件的 `resourceId`、`sourceHash`、`format`、`parserVersion`、`inputBytes`、`extractionTruncated`。`matches` 每项还包含分块 `id`、`part`、`partIndex`、`start`、`end`、`text`、`score`，可将该项的 resource id 和分块 id 交给原单文件 `ReadSource` 精确读取。文件版本改变后旧分块仍失效。`totalMatches` 是整个已选 corpus 的命中分块数，`hasMore` 表示全局结果还未返回完。

## 授权与回执

外层仍走 `ReadSource` 的现有 permission/Hook 管线。正文读取前，先验证**全部明确资源**的 metadata、Profile / workspace binding / Session pin、精确 resource 显式 deny 与已知总输入大小；permission preview 只用于预拒绝，不能批准正文读取。

随后按稳定文件顺序，逐项通过当前 ToolExecutor 的 pinned `executeBoundTool(ReadSource)` 执行一次真实读取。每项保留其自己的 permission、审批、pre/start/end/post Hook、capability off、run allowlist 和审计。后项拒绝、Hook 改写固定参数、撤权、取消、原件替换或预算超限，均使外层集合查询失败且不返回部分集合结果。此前已明确批准的单文件读取仍可能存在于现有子调用审计/记录中；不能将“集合无结果”解释为此前批准内容从未被读取或记录。

可信 index 与原件重验闭包来自这次实际读取的 typed local-files pipeline，经 executor-owned、私有 Symbol key 的单调用服务交给收集器。工具 JSON、Hook updatedInput、Hook prose 和显示结果均不能创建该 Symbol 身份。每个 bound 调用复制其服务 Map，进一步嵌套默认不继承；无全局可猜 call id capture，无从文本解析“可信回执”的路径，不新增 stable SDK 入口。子调用还必须通过已有 `boundToolResult` 的真实执行成功检查；既有 post Hook 的 additionalContext 保留为子调用附加上下文，不参与词法评分或来源证据。

每个 await 后重新检查 source/Profile/current pin、已选 resource 的当前显式 deny 和 workspace/state/uploads 目录身份；最终返回前同步重验每份实际原件的目录/文件 dev/ino、真实路径及内容 SHA-256。温缓存同样不能代替原件或授权，最后一次全量重验与输出之间没有 await。

## 预算与生命周期

- 每份原件最多 20 MiB；全部选定原件最多 40 MiB。metadata 预检超限在第一次正文读取前拒绝；实际 fstat 大小在分配输入 Buffer / 解析前同步占用共享预算，大小变化导致超限时整体失败。这是选定原件输入合计，**不是包括多次身份/哈希重验在内的总磁盘 IO 上限**。
- 收集的冻结 index 序列化合计最多 4 MiB。沿用单 Host 32 项 / 8 MiB 的 trusted 内存 LRU 及原有 2 个解析进程 / 16 个排队请求限制；这不是整个 Host RSS 的操作系统硬上限。
- 父集合 metadata 预检、实际读取/解析、排序、脱敏和原件重验累计计算预算 30 秒。单调时钟在父集合 metadata 返回、各授权围栏及最终同步重验后检查，避免只依赖延迟投递的 timer。子调用读取前准备（包含其目录 metadata）、permission / pre-start Hook 等待暂停这 30 秒预算，在实际 fstat 输入预留时恢复计时；整个调用仍受既有 registry 的默认 120 秒超时和上级取消约束。没有增加并发审批 barrier，也未改变全局 permission 快照语义。
- 集合 JSON 正文最多 256 KiB；超出时移除末尾低排名完整命中，保留有效 JSON 并报告 `outputTruncated` / `hasMore`。秘密值先在结构化值上脱敏，再序列化与包裹；截断和提取不完整状态独立保留。
- 不新建派生磁盘索引，不读取、迁移或清理 legacy `source-index`，不访问未选文件正文，不请求模型、嵌入服务、OCR 或第三方账号。

解析 worker 为每个实际 child 创建独立的 canonical、0700 HOME/config/state/AppData/tmp/cwd，只另外传递 PATH/必要 Windows 目录和 Electron Node 模式；多次并行解析不会共用 HOME，close 后清理各自持有的目录。入口先安装 fetch、HTTP(S) 默认/命名导出、TCP/TLS JS API guard，再通过 17 项真实负向探针，最后动态载入 parser 依赖。Bun 1.3.11 的 `syncBuiltinESMExports` 不更新命名 HTTP 导出，因此同时封住其 ClientRequest 在 native HTTP 调用前使用的 `getHeaders`，并实际验证命名 request/get；不以 Node 的导出行为代替 Bun 验收。这不是 OS 网络隔离，也不能约束任意 native 库或第三方代码主动重新打开 API。

私有 stdout 协议先发送真实 child PID/PPID、可执行路径、HOME/cwd、环境目录权限和 pre-import 探针数；worker 与自己实际 spawn 的身份/目录逐项核对后才接受解析结果。可选 Host 内诊断在 close 和清理后记录退出、取消、超时或 spawn 失败；回执不会进入 SourceContent、ToolResult 或模型上下文。可执行 SHA 仅在验收观察器中读取，不增加每次生产解析的二进制哈希 IO。

## 验证范围

目标验证覆盖统一 corpus / 并列排序、中文 Office、精确分块复读、参数与 scope 拒绝、末项拒绝、Hook deny/改参/prose、Profile/pin/显式 deny 中途变化、同字节原件/目录替换、metadata/实际输入/index 预算、取消和单调时钟到期。编译后的 SDK `Engine` 消费者使用合成的进程内模型回复和真实逐文件审批，真实 parser 子进程解析合成 UTF-8/DOCX，再以独立冷进程核对相同来源与结果。

原生 smoke 在首次 Core import 前验证私有 HOME，并拒绝 fetch、HTTP(S) 默认/命名入口、TCP/TLS 共 9 个负向探针；Host/cold 记录实际 PID/PPID、Node、可执行文件和实际 Core 模块 SHA-256。另观察真实 Engine/cold 调用实际生产 parser child 的 stdout 回执，核对每个 child 的独立 HOME、0700 目录、PID/PPID、实际执行文件 SHA、17 个 pre-import 探针及 close 后目录移除；单独覆盖真实取消、超时和 ENOENT 清理。测试进程与解析入口的 JS API 防护都不是 OS 沙箱；不代表真实用户文档覆盖率、实际模型效果或新版本已经发行。

最终本地候选验证：129 项 guarded unit 全部通过、零跳过，包含 34 项集合查询、9 项既有真实 parser 和 3 项新增 child 环境/生命周期覆盖；完整 JUnit 与实际 Bun/child 回执保留。serial package release 通过 9 个 tarball、47 个类型入口，之后 12 包 typecheck、lint 与 diff 检查通过。Node 22.16.0 和实际 Electron 33.4.11 / Node 20.18.3 均完成 SDK Engine 逐文件审批、Office/UTF-8 集合、冷消费者与实际 child 验证；另通过 Host-only resolver 指向已核对执行文件 SHA 的 Node 22.16.0，完成真实 `ReadSource` 的 PDF+文本集合查询。最终组合使用调用方持有的私有环境、`stdin=ignore` / stdout/stderr pipe 与 60 秒 fixture 上限，输出固定 10 个 Core 模块及 6 个 parser 依赖入口 SHA。

额外的独立 worker PDF 试验中，继承 stdio 的 Electron 父进程曾在已记录解析成功、child close/清理后未自然退出；失败日志保留，未找到新增未闭合的生产 owner。最终有界消费者验收并不解释或宣称修复了这个独立试验的未知退出问题。
