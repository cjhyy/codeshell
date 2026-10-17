# Host / Link 普通生命周期与数据续审

源码基线：`0f83bbfdfb8f2c6f31148250bd6544f5325c16e7`。仅审查和写证据，未修改产品文件、执行 Git 写操作或操作真实连接。结果：**2 项条件性 P3 确认问题、1 项已观察能力边界**；Host 普通生命周期和 worker 分派未确认新问题。下面的“确认”指生产纯函数行为及静态可达接线，不等同于真实 GitHub/Electron 端到端复现。

## 确认问题

### HL-01 · P3 · 精确 GitHub 文件引用裁掉文件名首尾空格，合并不同路径

- **位置**：`packages/link/src/file-selection.ts:15`，由 `:42` 将路径传入共用 `text()`；普通 UI 在 `packages/desktop/src/renderer/credentials/LinkedFileSourcesDialog.tsx:26` 也先裁剪每行路径。
- **可达触发**：选择带前导或尾随空格的仓库路径，例如 ` report.md`、`report.md ` 或全角空格开头的 `　report.md`。该字符串通过现有类型、长度和分段校验。条件是仓库确实含这种文件名；本轮没有访问真实仓库。
- **预期契约**：已有 `packages/link/src/file-selection.test.ts:27` 的正常路径测试写明精确 paths/refs；Desktop 的 `LinkedFileSourcesDialog.tsx:37` 与 `linked-file-sources-service.ts:144` 将选择定义为保存精确引用。owner/repo 的大小写归一化不意味着可以修改文件路径。
- **实际**：生产 resolver 返回的 `params.path` 是 `report.md`。四种不同输入与原始 `report.md` 都归为相同的 adapter 配置。`linked-file-sources-service.ts:117` 将该配置用于 `identity`，`:120` 计算 source ID，`:122` 保存默认标签。因此这些原本不同的精确路径会被同一 source identity 合并；输入已丢失，后续 reader 无法恢复。
- **影响**：这种文件名无法按原样选择。若裁剪后路径也存在，保存的引用指向它；若不存在，后续读取会找不到文件。**动态只证明路径变更及一个自有 Map 中的不同内容命中，未读取实际 GitHub 文件、未运行 UI/IPC 或 source 持久化。** identity 合并和后续读取影响由上述生产接线静态推出。Core 的 `packages/core/src/links/http.ts:174` 同样裁剪路径字符串，修复时需一并评估该边界；本轮未改代码。
- **证据**：[fixture](evidence/host-link-selection.test.ts) 第一项及 [首次 raw log](evidence/host-link-selection.raw.log)，4 个输入均打印 requested/selected；整组 `4 pass / 0 fail / 26 expect`，并有 `Completed Bun shard: 4 tests, 0 skipped; 0 failures.`。

### HL-02 · P3 · 长路径默认文件标签从半个 emoji 开始

- **位置**：`packages/link/src/file-selection.ts:90` 的 `defaultLabel.slice(-512)`。
- **可达触发**：GitHub 文件选择不传显式 `label`，路径长度超过默认标签上限，截断点刚好落在 Unicode 代理对中间。fixture 使用 `😀/` 后接两个 250 字符目录和 8 字符文件名，总计 513 个 UTF-16 单位，每段均不超过 255，路径没有非法分隔或控制字符，远低于 resolver 的 2,000 限制。
- **预期契约**：路径可以包含 Unicode；默认展示标签应保持合法 Unicode 文本。显式普通 Unicode 标签的对照项完整保留。
- **实际**：生产 resolver 接受且保留原始 `params.path`，但返回的 512 单位标签首字符是低代理项 `0xde00`，`label.isWellFormed()` 为 false，原路径则为 true。
- **影响**：默认标签带孤立代理项，显示或文本编码会产生替代字符。`linked-file-sources-service.ts:122` 将此标签写入 source definition，`packages/desktop/src/renderer/project-config/DataSourcesSection.tsx:241` 将 definition label 投影到数据源列表；这是显示元数据损坏，路径参数仍正确。**动态只运行 resolver，没有真实平台、持久化或字体/UI 截图验证。**
- **证据**：同一 [fixture](evidence/host-link-selection.test.ts) 第三、四项与 [首次 raw log](evidence/host-link-selection.raw.log)，观察为 `requestedLength:513, labelLength:512, firstCodeUnit:"de00", labelWellFormed:false`。

## 能力边界、候选与排除

- **HL-B1 · 已观察能力边界，不计 bug**：`docs/rate%2Ftable.md`、`docs/rate%5Ctable.md` 被 `file-selection.ts:46` 的 decode 后分段规则拒绝，而字面 `%20` 名称保留；fixture 第二项保留了这一结果。Core `links/http.ts:189` 的 `assertPathSegment()` 明确采用相同的原始/解码后双检查，`:215` 规定此格式经过每段验证后编码。尚无契约保证支持这两种字面表示，不能由“Git 文件名可能包含这些字符”直接推成产品 bug。本轮没有测试绕过或安全方向。
- **HL-B2 · 已声明边界**：只有 GitHub/Figma manifest 提供普通文件选择；Notion 的 `document-content-unavailable`、Figma Make 的不支持类型，以及 Host 同步 `start/stop` 都是当前明示边界，未包装成缺陷。没有对异步 adapter 做实验。
- **HL-C1 · 未确认**：`HostRuntime.register()` 保存 caller-owned service 引用（`runtime.ts:50`），dispatch 再读取 handler（`:114`）；若调用者后来改对象，登记快照可能与 handler 不一致。当前 Desktop/serve/Panel 的创建点均构造私有对象，未找到正常调用方后续变更；没有执行人为突变，不计问题。
- **重复核对**：两批 audit findings、2026-10-12 remaining findings、2026-05-30 findings，以及 2026-07-09 register、2026-08-13 report 共六个旧索引未找到这两个生产路径的同根因条目。`CHD02` 是相同 UTF-16 截断类别，但发生在 chat 附件名函数，消费者不同；列为相关问题，未作为重复移除。此为限定索引查重，非所有历史文档逐字穷尽。见 [dedup receipt](evidence/host-dedup.json)。

## 覆盖与精确收据

普通 Host 阅读 `runtime.ts`、`host-requests.ts`、公开入口及 Desktop/serve/Panel 创建和 dispatch 接线；基线覆盖原子登记、启动顺序、部分失败回滚、cleanup 错误聚合、反向停止、幂等、正常 handler、下游 route、未知请求数据分类。当前生产 caller 没有传入有副作用的 adapter start/stop，因此假 adapter 验证不能代表真实 native 生命周期。

Link 阅读 manifest/文件选择、operation contracts、`snapshotJson`/结构匹配、公开入口、普通 metadata 投影；类型文件仅核对数据形状。authorization/filter 和凭据/认证实现未作为审查目标，未运行相关操作单测。operation 基线验证 immutable catalog 快照、Figma summary/content 的输入输出区分，以及深层普通结果数据保留。29 个被读取或静态接线核对的源/测试文件和 SHA-256 见 [source manifest](evidence/host-source-manifest.json)，其中消费者大文件仅阅读相关调用段，不能当成整个文件全覆盖。

所有动态均从首次执行就把 stdout/stderr 写入自有 `.raw.log`，通过 `node scripts/run-bun-test-shard.mjs --timeout 30000 ...` 执行；没有动态失败、重试或补修 fixture。Bun 版本 `1.3.11 (af24e281)`。

| 收据 | 执行结果 | wrapper 完成信息 | 范围 |
| --- | --- | --- | --- |
| [host-link-selection.raw.log](evidence/host-link-selection.raw.log) | exit 0；4 pass，0 fail；26 assertions | 4 tests，0 skipped | 自有 resolver 纯函数；包括 1 项能力边界观察 |
| [host-baseline.raw.log](evidence/host-baseline.raw.log) | exit 0；19 pass，16 filtered out，0 fail；88 assertions | 35 tests，16 skipped | 16 个 Host 假 adapter/解析用例及 3 个普通文件选择用例 |
| [host-operation-baseline.raw.log](evidence/host-operation-baseline.raw.log) | exit 0；3 pass，6 filtered out，0 fail；209 assertions | 9 tests，6 skipped | 仅普通 catalog/schema/result 用例 |

合计 **26 项实际通过、22 项按名称筛选排除、0 失败，323 assertions**。wrapper 总 tests 为 48，其中包括 22 skipped；不能写成 48 项已执行通过。完整命令、退出码和日志哈希见 [receipts](evidence/host-receipts.json)。

剩余覆盖缺口：真实 provider/API/CLI/MCP、native adapter、Electron 对话框与持久化端到端均未执行；真实平台是否接受所列条件文件名未验证。未接触用户数据、真实消息、模型、网络 fixture、权限/认证或此前平台中止方向。产品问题均未修复。
