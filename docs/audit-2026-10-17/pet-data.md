# Pet 普通数据投影 / 内容定位审查

基线 `ab8b03f86ad38835939d4125b56bf4513cae7f15`，仅写此文件与 `evidence/pet-*`。产品/Git/依赖只读；不执行权限/认证流程、真实发送或模型。先读旧 `docs/audit-2026-10-16/findings.json` 查重，与当前chat分审范围隔离。

## 第一轮：disclosure 内容搜索

读取 `disclosure/{search,catalog,jsonl,latest-result,todo-snapshot,selector}.ts`、`sessions-tool.ts` 关键接线，以及 `session-index.ts`、`projection-extension.ts` 关键投影段。已知旧R56的500候选截断提示不重复报告。源码候选：搜索先在JSON原文做substring预筛，正常内容中的引号/反斜杠被JSON编码后可能被过滤。聚焦自有tmp源码实验 `evidence/pet-search-json-text.test.ts` 首次成功，完整首跑日志 `evidence/pet-search-json-text.log`：3 pass /7 expect /0 fail/skip /Completed。

## PET-01 [P3] 对JSON原文的搜索预筛使正常引号代码与Windows路径查不到

- 位置：`packages/pet/src/disclosure/search.ts:123`，在JSON.parse与真实content查找前，用未编码query对JSON原文做includes预筛。
- 触发：健康消息正文 `Use console.log("hello") and file C:\work\notes.txt`，正常JSON.stringify写入transcript；内容搜索输入 `console.log("hello")` 或 `C:\work\notes.txt`。
- 预期：全文substring搜索应按消息解码后的正文匹配，并返回该条对话片段。
- 实际：JSON中引号/反斜杠已被编码，raw文字不包含原query，进入实际解码搜索前就continue。两个query均得 `matches=[] /scannedSessions=1 /truncated=false`；普通 `hello` 对照返回同消息，snippet完整保留引号代码。
- 影响：正常聊天里的代码表达式、带反斜杠路径无法按原文查找。`sessions-tool.ts:196` 的Sessions search与Desktop `main/index.ts:5026–5031` 内容搜索均消费这个helper；真实工具/IPC/UI为静态接线，未执行发送或模型。
- 证据：`evidence/pet-search-json-text.test.ts` 直接相对导入生产helper，使用自有tmp健康state/transcript和真实本地reader；完整日志 `evidence/pet-search-json-text.log`。首跑3 pass /7 expect /0 fail/skip /Completed，自有目录finally删除。
- 查重：10-16主findings无同项；10-12 R56为500候选超出却不提示，本项单一已扫描候选内因JSON编码错误预筛，独立根因。相关search-routing/quality主报告未检出引号/反斜杠同项（有限查重）。

## 第二轮：segment / 投影普通生命周期

已阅读 `topic-segment.ts` / `segment-closure.ts` 的完整纯函数、`session-index.ts` 的生命周期归属/世代、`im-session-list.ts` 的状态和编号、`session-visit-receipt.ts` / `context-recall.ts` 的文本与选择边界，另对 Desktop `pet-segment-closure-service.ts` reader/range关键段、Core transcript/Engine已存在anchor归档注释作只读接线核对。

- 第二个独立guarded首跑 `evidence/pet-projection-segment.test.ts`：3 pass /11 expect /0 fail/skip /Completed，完整日志 `evidence/pet-projection-segment.log`。实际纯函数动态确认旧run终态/子agent终态不能关闭当前parent，旧cursor拒绝；重复prose按精确client ID定位segment；归档行过滤后ordinal匹配真实渲染列表。
- Segment closure原始范围与live归档范围的潜在差异，有现有Engine anchored归档路径明确反证：带anchors时忽略raw index范围重新定位，因此没有把未执行的错位猜测发布为bug。
- Latest-result/todo reader保留有界tail设计，超大单行/任意导入格式/真实renderer消费没有动态验证；未据此扩大正式发现。
- 未发现第二项新的可确认Pet缺陷。旧R56搜索候选提示、真实发送/权限/认证路径不在本轮新增实验内。

## 执行与源码收据

2个独立guarded首次shard，合计6 pass /18 expect /0 fail/skip，全部Completed；没有失败支架或重试。`evidence/pet-source-manifest.json`记录关键生产源码与证据SHA-256，关键生产源码均逐字节匹配冻结Git blob。

## 边界

没有真实Desktop/Pet窗口、协议transport、账户、IM发送、LLM或原生进程。纯函数/文件reader证据不等于端到端UI验收。
