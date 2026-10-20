# Chat ingress 普通端点与低耦合叶子补查（第十七批）

冻结源码：`d86db33012dffd5d1849e76b869fa15eb260324f`。本方向新增 **1 项 P3 确认缺陷、0 项候选**。只写审查材料；产品代码、Git、依赖与 dist 均未修改。

## CHAT-R17-01 — P3：显式 loopback HTTP 80 端口在配置生成前被误判成缺少端口

**位置与普通入口。** [ingress.ts:60–63](../../packages/chat/src/ingress.ts#L60) 用 `new URL` 解析带 `http://` 前缀的端点，再以 `!url.port` 判断缺少端口。URL 会把 HTTP 默认端口 `80` 正规化为空字符串，因此明确给出的 `127.0.0.1:80`、`localhost:80`、`[::1]:80` 都在 [70 行](../../packages/chat/src/ingress.ts#L70) 抛错。CLI 的 [printIngress:213–231](../../packages/chat/src/cli.ts#L213) 将普通 `--upstream` 参数原样传给该 helper；不需要异常类型或额外代码注入。

**合同与影响。** [Chat README:364–370](../../packages/chat/README.md#L364) 提供生成 ingress 配置的 CLI，并明确上游允许 `loopback host:port`，没有声明排除显式 `:80`。该端点符合文档给出的形状且属于实现允许的 loopback 主机。另静态核对 [config.ts:337](../../packages/chat/src/config.ts#L337) 将配置端口交给 [readPort:856–860](../../packages/chat/src/config.ts#L856)，后者接受整数 1–65,535，故 Gateway 配置层并未排除 80；没有执行配置加载器或创建 listener。用相同 host 的 `:8080` 能生成配置，换成 `:80` 却在返回配置前失败。这影响自定义本地 HTTP 上游使用 80 端口的配置生成；默认 `127.0.0.1:8787` 正常。端点是否真的有 listener 与此纯字符串拒绝无关，本轮没有创建服务或演练部署。

**真实最小复现与控制。** [首次 fixture](evidence/frontier-ingress-port.test.ts) 绝对路径导入真实、无运行时 import 的 `ingress.ts`。对三种 loopback 主机分别调用 Caddy/Nginx 两种格式，六个 `:80` 调用均抛出 `webhook upstream must be a loopback host:port`；标准 URL 对照直接确认其 `.port === ""`。完全相同主机的六个 `:8080` 调用都返回含有原端点的配置。另有默认 upstream、普通 DNS 主机大小写/空白正规化、固定 webhook paths 和自定义 body 大小的成功控制。测试是错误行为的 characterization，不是修复后通过证明。

**证据范围。** [FIRST raw](evidence/frontier-ingress-port.first.raw.log) 与 [exit receipt](evidence/frontier-ingress-port.first.exit.json) 先保存再读取：**3 tests / 22 expectations / 0 failures / 0 skipped / Completed / exit 0**。动态范围只有纯生成器与内存字符串；CLI 接线为静态读取，没有导入 `cli.ts`、启动 gateway、Caddy/Nginx、listener 或 SDK。未作网络、账号、认证/权限、安全边界、平台发送、模型、native/PTY 或用户数据实验，不把生成器失败写成实际运行中的代理故障。

**历史查重。** [专项历史扫描](evidence/frontier-specific-dedup.json) 覆盖全部 prior `docs/`、`bugs/` 下 **1,134 Markdown + 804 parsed JSON**，含 archive/_archive，当前 round17 排除；JSON 有 **239,449 string leaves / 335,081 scalar leaves，0 parse errors**。ingress 关键词 35 个匹配主要是旧覆盖清单/设计文档，默认端口/精确 `:80`/`url.port` 关键词 0 个匹配。保留上下文上限每类 60 条，计数没有被该上限裁剪；扫描脚本和完整路径/SHA inventory 随材料保留。读取这些匹配后未找到同根因旧 finding。关键词扫描是查重辅助，不代表穷尽所有旧文档语义。

## 选择过程、旧问题排除和覆盖边界

从真实 `packages/chat/src`、`packages/host/src`、`packages/link/src` 库存选叶子；[初次模块查重](evidence/frontier-dedup.json) 与上述专项扫描统计相同，按 ingress/channel/media/file selection/Host 家族分别计数，保留上下文上限每类 40。初始合并源码输出发生工具显示截断，未据此声称完整读取 media/delivery queue。最终完整读取的是 `ingress.ts`、`channel.ts` 及两者既有测试；CLI、README 只读上述选段。

- `channel.ts` 的 capability matrix、旧第三方 adapter fallback、附件 kind 判定是普通数据投影；既有第十一批已运行 channel baseline，本轮只读核对，没有重复动态验证、没有新增发现或候选。
- 选择阶段读到的 Bound Session 附件缺投影已在 [旧 Chat 报告](../audit-2026-10-17/chat-data.md#L30) 排除为已知交付限制，并由 [Mimi replay 草案:77](../todo/mimi-chat-replay-2026-09-06.md#L77) 明确限定；本轮不构造复现、不新增关联数量。
- Unicode 附件名、Link file selection 空白/Unicode、Slack threads、LINE button lengths、DeliveryQueue FIFO/ACK 和第十一批 Markdown/notification progress 不复审。共享 media 同对象并发 tracker 没有普通调用合同，不由自造并发登记缺陷。
- Host 生命周期/barrel、Link operation 授权/资源校验与运行平台边界不是本方向动态对象。没有从它们的库存或源码选择阅读推导覆盖全部包。

## 首次验证与材料

唯一命令：`node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round17/evidence/frontier-ingress-port.test.ts`。**1 clean shard，3 focused tests / 22 expectations；0 existing baseline，0 failed shard，0 reruns**。未运行 broad build/typecheck/lint/full suite。首次 [preflight](evidence/frontier-preflight.json) 只核实际 leaf/runner 文件存在和 frozen Git bytes；未猜根 node_modules、未执行 resolver。无导航命令失败，无 fixture/import/assert/platform 失败，也没有恢复旧失败方向。

[findings](evidence/frontier-findings.json)、[candidates](evidence/frontier-candidates.json)、[validation](evidence/frontier-validation.json)、[source manifest](evidence/frontier-source-manifest.json) 与 [artifact receipt](evidence/frontier-artifact-receipt.json) 分别给出结论、计数、逐文件 SHA 和材料完整性。源码散列只标定所读/所执行版本；选段 source pin 不代表完整文件或传递 import graph 已审。
