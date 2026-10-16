# 未确认、未继续执行与历史问题

本页内容不计入确认问题数量。记录它们是为了避免后续审查丢失线索或把未完成实验误称为 bug 复现。

| 线索 | 已有证据 | 缺少的证据/停止原因 |
| --- | --- | --- |
| AuxiliaryPipeline 对同 provider/model/baseUrl 的不同 auxText 账号复用 primary client | `auxiliary-pipeline.ts` fast path 忽略凭据，既有测试有意断言这一点 | 尚未完成真实 defaults.auxText 消费链与账号选择语义复核；平台检查中止后没有继续或改道实验，未登记确认 |
| MemoryStoreView 的旧 pin 请求晚到，可能在切 user→dream 后重刷 user 列表 | 源码 closure/generation 初步分析；保存 `evidence/desktop-memory-scope.test.tsx` | fixture 在 import `react-dom/client` 时失败，0 pass / 1 fail；没有进入组件行为断言。保留 `desktop-memory-scope.log`，不算产品失败；后续平台中止后未修支架重试 |
| ChromeNativeBridgeServer 未认证连接会阻塞 stop | 本轮重新读源码，匹配旧 N18 / hosts N01 | 已是旧报告确认项，本轮没有新网络/关闭实验，不计新问题，也不称当前基线动态复验 |
| Mattermost 与 Matrix 类似的可选 self ID 过滤 | 静态相似结构 | SWC-04 动态范围只覆盖 Matrix，没有把 Mattermost 也计作已验证 |
| Mobile 输出背压、Chat 同 target 重试越序、Telegram allowlist 前下载 | 当前代码初读后与旧报告查重 | 本轮未做独立动态复验，不重复计确认或宣称修复 |
| PTY 旧 exit 按 key 清除替换 entry | 静态 seam | 没找到正常 renderer 原位 kill/restart 的可达入口，不能仅凭内存 seam 判定用户流程 bug |
| 文件权限检查与打开之间的通用竞态 | 静态理论风险 | 未构造正常生产触发，未登记确认 |
| Cloud binding controller 按 ID 缓存可能保留旧显示名 | 静态观察 | runtime store 对不同目标生成新 ID，尚不能认定身份错误 |
| useSettingsResource 的 loader 变更不会自动 reload | 静态观察 | 未找到会改变 loader 的真实消费者，未登记确认 |

平台内容检查先后中止了部分分审工作。所有受中止的动态方向均已停止，没有换工具或改道重试。其前已完成的证据与之后只做的文件整理分别记录在分报告中；这不是用户确认/授权缺失，也不把中止本身计为产品缺陷。
