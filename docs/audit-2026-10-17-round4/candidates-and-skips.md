# 未确认、重复与跳过

下列项目均不计入本批 7 个确认问题。详细源码条件和证据边界见对应分报告。

| 方向 | 状态与原因 | 记录 |
| --- | --- | --- |
| CLI 参数空白保真、/log bucket 路径、/compact session owner、/config scope | 4 条静态候选；首次共享夹具在产品动态导入前因 ESM namespace readonly 赋值失败；0 pass/1 fail/1 error、无 Completed，无业务断言执行；保存原始文件/日志后跳过，不修复或重试 | [root.md](root.md)，root-cli-data.first.log |
| dev recorder 跨 UTC 午夜仍用旧日期缓存路径 | 首次独立夹具比较 `/var` 与 `/private/var` 路径字符串控制失败；0 pass/1 fail/2 expect，无 Completed；尚未记录事件。保留临时 LOG-R4-02 编号但仅候选，未修支架/重试 | [root.md](root.md)，root-recorder-day.first.log |
| Image compaction/reload 编号漂移 | 旧 refactor review 已确认，同根因重复排除，没有新增实验 | [context.md](context.md) |
| Sync cached summary 范围、批量短 tool outputs 超预算、失败浏览器 snapshot 覆盖成功观察 | 静态线索，当前合同/可达影响未充分确认，没有测试 | [context.md](context.md) |
| Legacy migrateModels 混合格式重算 providerKey | 当前 Engine 已消费 modelConnections，没有证实正常模型请求影响；仅候选 | [settings.md](settings.md) |
| Generic migrateConfig gap/future stamp | 生产迁移连续，stamp-only 差异不持久化；未确证正常入口 bug | [settings.md](settings.md) |
| LSP hierarchical symbols / LocationLink selection range | 当前 client 未广告对应能力；未把非当前协商形状当作缺陷 | [coding.md](coding.md) |
| LSP per-extension languageId | 静态候选，没有特定 server 行为证据 | [coding.md](coding.md) |
| LSP startup/failed initialize/dead child/旧 failed fixtures | 历史已记录或已失败方向排除，没有重跑、安装真实语言服务器或绕过 | [coding.md](coding.md) |
| earlyInput escape parser、simple-diff O(n*m) | 前者未找到当前启动调用；后者仅静态成本，无压力证据，不计 bug | [root.md](root.md) |

失败收据是审查夹具/环境现象，不是已确认产品 bug。独立 logger retention 验证与跳过的 CLI log 命令/dev recorder 日期实验属于不同函数和行为，没有以另一种方法重试后两者。
