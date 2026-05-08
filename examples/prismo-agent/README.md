# Prismo Artifact Agent

基于 CodeShell 的 Prismo 产品文档 Agent 示例。

> 这是 Phase 0 的 fixture 版：不连真实 Prismo 后端、不连数据库，
> 只用内存 fixture 证明 CodeShell 可以驱动 PRD / 流程图 / 原型 这套
> artifact 工作流。

## 目录

```
examples/prismo-agent/
├── src/
│   ├── product.ts      # defineProduct(prismo-artifact-agent)
│   ├── tools.ts         # LoadPrismoContext / SaveDraftArtifact / RunArtifactEvaluator
│   ├── evaluator.ts     # PRD / Flowchart / Prototype / Consistency 四类检查
│   ├── fixtures.ts      # 模拟 project / messages / inputs / artifacts
│   └── main.ts          # 入口：跑 prd_bundle 工作流，写 run-events.json + draft-prd.md
├── output/              # 运行输出（draft、events、findings）
├── package.json
└── tsconfig.json
```

## 三条工作流（见 `docs/codeshell-prismo-agent-implementation-plan.md`）

| Workflow              | 第一版状态           |
| --------------------- | -------------------- |
| `prd_bundle`          | ✅ Phase 0 跑通      |
| `revision_sprint`     | ⏳ Phase 3            |
| `consistency_audit`   | ⏳ Phase 5            |

## 跑通 Phase 0

```bash
export OPENAI_API_KEY=sk-...
# 或 OpenRouter
export OPENROUTER_API_KEY=sk-or-...

cd examples/prismo-agent
bun run src/main.ts
```

完成后会在 `output/` 下生成：

- `run-events.json` — 完整的 run 事件流
- `draft-prd.md` — agent 生成的 PRD draft
- `evaluation.json` — evaluator 输出的结构化 findings
- `draft-flowchart.mmd`（如生成）
- `draft-prototype.html`（如生成）

## 设计约束

- Agent **绝不**直接覆盖正式 artifact，所有产物先以 `draft` 状态写入；
- Tools 都是 fixture-only，未来在真实 Prismo 部署时换成 HTTP API client；
- Evaluator 输出结构化 findings（severity/section/artifactId），方便前端展示；
- 系统提示词强制 agent 读取已有 project context 后再产出。
