# 上传文档解析与逐文件索引交付边界

2026-10-09。复用项目配置中的上传入口与 `ReadSource`；不新增侧栏或工具，不改变逐资源授权。此文记录源码和本地真实解析验收，发布以合并版本为准。

## 支持范围

- UTF-8 文本（含 Markdown、CSV、JSON 等）、DOCX、PPTX、XLSX 文本提取。Office 使用真实 ZIP/XML 解析，保留段落、页/工作表标签及工作簿/演示文稿关系顺序；公式只读已有缓存值，不执行公式、宏、外部关系或脚本。
- PDF 使用官方 `pdfjs-dist@6.4.299` 的文本接口，是 **Node.js 22.13+ 且已安装可选依赖**时的能力。Core 的 Node >=20.10 最低要求保持不变；旧 Node 或缺少可选依赖时给出升级/重新安装/导出 UTF-8 文本的说明。
- Desktop 复用已经随安装包供应的 managed Node（当前锁定 24.21.0），PDF 解析在该独立 Node 子进程运行；Electron 33 内置 Node 20.18.3 不需要升级。运行前复用现有 runtime manifest/平台/哈希验证。开发环境需运行 `bun run --cwd packages/desktop runtime:prepare` 准备同一受校验运行时；缺失时明确提示重新安装/准备或导出文本。普通 Core Host 可注入可信 `documentParserExecutable` resolver，工具参数、项目设置和协议不接受可执行路径。Desktop 将仅解析入口/UTF-8 辅助与真实解析依赖闭包置于 `app.asar.unpacked`，外部 Node 使用此物理入口；不展开全部 Core/LLM 依赖。
- 不支持旧二进制 DOC/XLS/PPT、加密文档、扫描件 OCR、版式还原、向量化或跨文件检索。空文本 PDF 提示 OCR/文本导出；当前 PDF 验收为真实英文文本 PDF，不声明所有字体/复杂表格均可完整提取。

读取输入最多 20 MiB（上传入口保留既有上传大小限制；更大的文件可存放，但读取时需拆分）。提取文本最多 1 MiB、500 个文档部分、200 个 PDF 页面、512 个分块；达到上限会报告截断。每块最多 3,000 个 UTF-16 字符，重叠 200 字符且不拆开代理对。工具结果仍受 256 KiB 与秘密脱敏限制。

Office ZIP 额外限制 2,000 项、32 MiB 声明/选中解压总量、每 XML 8 MiB、20 万 XML 元素和 128 层深度；拒绝 DOCTYPE。文件不解压到磁盘，不跟随外部关系。

## 查询、引用与权限

先 `ListSources` 查看文件 metadata；它不创建索引也不读出正文。所有内容入口仍要求同一个 `source`、`scope`、`resource`：

```json
{
  "source": "project-uploads",
  "scope": "uploads",
  "resource": "brief.docx",
  "query": "项目预算",
  "limit": 5
}
```

查询在该文件的分块上运行本地词法评分，支持 Unicode 单词与中日韩字符二元词，无模型/嵌入请求。结果包含 `resourceId`、`sourceHash`、`format`、`parserVersion`、`extractionTruncated`、`totalMatches`、`hasMore` 和带部分标签/偏移/分数的 `matches`。用返回的分块 ID 再读：

```json
{
  "source": "project-uploads",
  "scope": "uploads",
  "resource": "brief.docx",
  "chunk": "c_<返回的24位十六进制ID>"
}
```

`query` 和 `chunk` 互斥；`limit` 只用于查询，范围 1..20；这些参数仅适用于项目上传源。原有不带查询参数的读取仍返回提取正文。分块 ID 绑定文件内容 SHA-256、资源和偏移，文件内容变更后旧引用明确失效。

Profile、workspace binding、Session pin、`ReadSource` permission 和精确 resource deny 在读取前继续生效；索引命中也不省略这些检查。解析 await 后和结果返回前再次检查授权、workspace/state/uploads 目录与原文件的 dev/ino/真实路径身份、实际内容哈希。缓存不会让已删除、已撤权或已替换的文件继续可读。结果保留来源标记、脱敏与不可信内容包裹。

## 执行与索引存储

解析在独立、可终止的子进程内运行；不把 PDF/native 库载入 Host。子进程只收到已授权的有界字节和文件名，不收到原文件路径；只继承 PATH/Windows 系统目录和 Electron Node 模式所需变量，不继承第三方凭证环境变量。解析入口禁用 fetch，Office 不解析外部关系；这不是通用操作系统沙箱。

单 Host 最多 2 个解析进程、16 个排队请求；队列满时返回忙碌提示。运行时 resolver 的等待有独立 15 秒上限并可取消；解析进程默认 15 秒超时，取消/超时杀掉子进程并等待 close 后释放槽。Node/Electron 子进程设置 192 MiB V8 堆上限；这不是整个进程 RSS 的操作系统硬上限。

派生索引存于项目 `.code-shell/source-index/`，新目录权限 0700、索引文件 0600，以临时文件原子发布。文件名是资源 ID 哈希，索引版本与实际原文件内容哈希绑定。磁盘缓存属于 workspace 可写数据，不能凭其自行声明的 hash/chunk ID 认证正文：冷启动始终从原件重新解析后替换它。当前进程只复用自己实际解析并冻结的索引，按原件哈希与 parser version 匹配；内存 LRU 最多 32 项/8 MiB。伪造合法形状的缓存不能进入结果。索引含提取的明文，请按项目资料保护该目录。

Desktop 覆盖/删除上传时清除对应索引；外部编辑在下次读取时靠实际内容哈希失效，即使恢复原大小/mtime 也不能命中旧版本。外部删除原文件后派生文件可能留在磁盘，不能单独提供内容；当前无全项目索引容量管理或孤儿清理。删除整个 `source-index` 可以重建缓存。

## 验证证据

- 真实 ZIP/XML DOCX/PPTX/XLSX 与真实 PDF fixtures：文本、关系顺序、缓存公式、Unicode、XXE/压缩量界限、重复大 shared string 的增量预算、非法二进制、截断、活动取消/超时与满队列恢复。
- 真实 `ReadSource` / `ToolExecutor`：中文查询、缓存复用、精确文件 deny、Profile deny、解析时撤权/覆盖、损坏缓存/符号链接、同字节目录替换、伪造正文磁盘 cache 的 warm/cold 拒绝、脱敏和来源包裹。
- Desktop 上传服务：覆盖与删除清除已有实际派生索引。
- 官方 SHA-256 验证的 Node 20.10.0 / 22.13.0 / 22.16.0 跑编译后的生产 Core/ToolExecutor/解析子进程；前者验证 Office 与 PDF 版本门禁，后两者验证真实 PDF。另实际暂时移除可选 PDF 包验证缺依赖说明；已还原。
- Electron RunAsNode 跑相同生产路径，验证实际 Node 20.18.3 → manifest/hash 验证的 managed Node 24.21.0 → 真 PDF 子进程。CI 增加三个原生 Node 版本烟测及 Electron managed PDF 烟测。
- 实际执行 Desktop `predist`，可选 PDF 包及 native canvas 闭包保留。用真实 ASAR 归档与相同 unpack 规则验收：Electron 从归档载入生产 worker，Office 走 Electron 子进程，PDF 走物理 unpacked 入口/依赖 + verified managed Node，均读取真实文本。macOS arm64 fixture 的归档为 182,518 字节、unpacked 解析闭包为 63,385,807 字节（约 60.45 MiB）；完整 Core production 闭包约 154.03 MB，没有全部展开。此数据为运行文件体积，不能等同完整安装器压缩体积；其它平台/架构的 native canvas 需各自打包 runner 验收。
- 发布包门槛通过 9 个 tarball / 47 个声明入口，另在实际打包后的 SDK consumer 执行解析/查询/覆盖/删除及伪造冷缓存拒绝；不使用付费模型或第三方账号，不把 fixture 当成真实用户资料覆盖率。
- 合并成本账本 main 后的最终组合检查：136 项 Source/权限/Engine/账本/Desktop 测试通过、12 包类型检查通过、变更生产代码 ESLint 通过；Desktop production 构建及既有 Workspace 页面 Electron 验收通过。
