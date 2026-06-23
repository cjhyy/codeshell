# Contributing to `@cjhyy/code-shell-core`

## core 边界契约 — 先读这条

**core 要保持独立、最小:它只装「机制(mechanism)」,不装「策略与目录(policy & catalog)」。**

core 是一个通用 agent harness(引擎 / turn-loop / 工具系统 / 权限沙箱 / LLM 抽象 / 会话协议)。
具体业务、产品特性、可变目录数据**不该长在 core 里**——它们外移到 data 文件 / 独立可选包 / host(desktop·tui)/ plugin。

| 进 core ✅(机制) | 不进 core ❌(去 data / 包 / host / plugin) |
|---|---|
| 引擎、turn-loop、tool-system 框架、executor | 具体某个 provider 列表、模型元数据、定价、地域映射 |
| 权限 / 沙箱 / hook **框架**与接口 | 某个端到端特性(多模型评审 Arena、视频生成流水线) |
| LLM 客户端抽象 + capability **机制** | 用户可见文案、产品名枚举、部署 / 雇主假设 |
| 会话 / transcript / 协议 | 任何「更新它就要发 core 版本」的目录数据 |

### 任何 core PR,review 时先问这三句

1. 这段逻辑**换个产品 / 换个部署**还成立吗? 不成立 → 不进 core。
2. 更新它需要**发 core 版本**吗? 需要 → 它是数据,该进 `src/data/` 数据层。
3. 它是**机制**,还是**某个特性的实现**? 是特性 → 该进可选包或 plugin。

### 实践约定

- 新加**业务性**功能(如某 provider 特定逻辑、某产品特性工具),即使**暂时**放 core 里能跑,也要**做成边界清晰、可整块拎出**的单元——别散进 core 各处、别跟 core 内部深度耦合。目标是后续能整体迁到业务层而不用大改。
- 目录 / 表格类数据(模型元数据、地域、定价、provider 列表)放 `src/data/*.json` + 小 loader(范式见 `src/data/static-catalogs.ts`、`src/data/model-metadata.ts`),build 的 `copy-assets` 会把 json 复制进 dist。
- 给 TUI-only / host-only 的导出加 `@internal` JSDoc(见 `src/index.ts` 各 `extended for TUI` 段),别让它们被当成稳定 SDK 面。

### 背景与进展

完整评估、迁移路线(Phase 0 立契约 → Phase 1 目录数据外移 → Phase 2 抽 `@codeshell/arena` 包 → Phase 3 加固)见 `docs/core-design-assessment.md`。
已做:Phase 0(本契约 + 删内部部署探测 + `@internal` 标记);Phase 1 过半(模型元数据 / Vertex 地域已外移到 `src/data/model-metadata.json`)。

> 一句话:**新东西默认落点不该是「再加个 builtin + 再 hardcode 一张表」。先过上面三问。**
