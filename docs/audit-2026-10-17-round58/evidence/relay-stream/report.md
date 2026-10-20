# prep139：Relay 普通字节流与关闭合同静态复核

结论：**0 新正式问题、0 新候选、0 new-related**。仅针对真实连接器的控制消息→本地流→原始字节 Duplex 和收尾数据合同，没有证据将普通输入下的消息边界或关闭路径升级为缺陷；这不证明整套 Relay 或真实网络时序正确。

Root 提供的产品基线为 `f31a847f45e4805bce34aeb9e6db7efb503cfcb0`。本读者未读取 Git；CODESHELL/AGENTS 延续此前实际阅读并核同 SHA。仅在本 tmp 输出，未改产品。

## 实际链与反证

- `connector.ts:192–203` 将控制 WebSocket 当文本 JSON，拒绝 binary 后再调用 DTO parser；`:214–240` 发送 JSON ready/failed，打开正常 open 对应的 local stream，并在 `done` 后删去所属流。`protocol.ts:2–17/38–70` 提供大小、chunk、类型与字段投影。数据通道与控制消息处理分开。
- `local-stream.ts:97–102/111–122` 构造 data WebSocket 时保留 64 KiB payload cap、关闭压缩，open 后创建 Duplex，再 `socket.pipe(bytes).pipe(socket)`。`:13–87/103–125` 的普通状态字段区分附着、TCP/WS 关闭、排空与 disposed；`done` 仅在两边 close 都回报后结算。URL/header/凭据或完整握手机制没有被认证。
- `byte-stream.ts:14–20` 检查完整 WS message 的 binary/大小；`:34–44` 按回调顺序将出站 Buffer 切为最多32 KiB，未将每个 chunk 擅自转为文本。`:46–63` 将正常 EOF 与非正常 close 分开，正常 EOF 的缓冲读取保留分支明确存在。没有普通 producer 证据说明一定丢尾字节；也没有执行 ws/Node 事件顺序来证明该分支在所有时序下正确。
- 不能把 HTTP `request.end()` 自动当连接 EOF：`docs/device-relay.md:99–110` 明确一条流代表整条 TCP、无自定义 half-close；声明的 fixture `runner.mjs:73–104` 将请求 body 的 end 与响应完成后的 Agent 销毁区分。`local-stream.ts:55–85` 对已有响应的 EPIPE/reset 或异常 TCP close 有有界排空路径，销毁/取消则另行关闭。任意文本 data frame、伪造 token 或错误 DTO 不构成普通 producer 缺陷证明。
- `connector.ts:159–164/233–240/254–275` 的关闭与回收链会主动关闭 owned streams，并等 pending；本次没有观察真实 socket 回收或无限等待，也不对权限/authority 作完整结论。

## 旧范围与测试边界

原 `round14/evidence/bytes-source-manifest.json#/files/5` 与当前 byte-stream 同 SHA，且 `round14/bytes.md:18` 明确全文阅读。因此这65行是**旧 full 重叠的定向复核**，不计首次或新唯一覆盖。protocol 原文只说相关合同；local 原 preflight 也只是所述选段，不能凭哈希或 derived index 扩写成旧 full。旧 R68 的 paired Host live-output backlog 原因继续保留，不用 Relay 的分片回调推翻它；ChromeNative、旧 UTF8 和失败 NDJSON timer 方向未恢复。

现有 `relay.native.test.ts` launcher 全文只作导航，实际普通 fixture 仅选段阅读：`byte-stream.mjs:27–43/51–62` 声明5种长度的慢 EOF reader 与突然断开；`runner.mjs` 所选段声明 early response、truncated response、Range、大响应、取消、binary/size 等对照。**全部未执行**；源码中的 PASS、断言或旧结果不能当本轮通过。

[源范围](source-manifest.json) 共7语义文件，1full（已知旧读重叠）/6selected：447语义行 = 301产品 + 125测试声明 + 21文档合同；另1个 native launcher 仅导航。实际显示联合725行，显示与普通语义范围分列；完整显示的协议/本地流并不等于完整机制审查。源证据截取在实际显示后保存，见[选段](source-excerpts.json)，未运行这些文本。

## 历史、诊断与冻结

Root 的共享 [历史投影](shared-history-projection.json) 保留5850份 MD/JSON、4251467个 JSON value scalar、0 parse errors，纳冻57排58及以后，含 archive、排 JSON keys。byte/local/protocol 分别54/38/60命中，cap100，均全部保存；机器访问不等于全史语义阅读。亲读原对象和 MD 的窗口见[历史范围](history-read-windows.json)及[gate](gate-decision.json)。自己的22份 path/SHA 原始命中文档仅作字节库存，不能替代具体 cause 全读。

本任务无首次产品尝试；[诊断](diagnostics.json)记录本次元数据/导航无失败或截断。[结束核对](ending-checks.json)记录10个产品/测试/文档/指令字节 pins、22份原命中加1份补充历史 MD和共享 batch 的结束 SHA，全部一致；共享 batch 同字节不表示本读者重验所有5850成员。该 dated snapshot 不认证未来文档或 Git 状态。

[分类](classification.json)、[验证边界](validation.json)、[原始pin](initial-pins.json)、[消费者pin](support-pins.json)、[测试pin](test-support-pin.json)、[字节测试pin](byte-test-support-pin.json)、[原历史pin](targeted-history-hits.json)、[历史补pin](history-support-pins.json)均保留。[最终清单](reviewer-receipt.json)自排除；[元数据检查](freeze-checks.json)的 `checks.files=[]` 不冒充另一份独立源码审查。
