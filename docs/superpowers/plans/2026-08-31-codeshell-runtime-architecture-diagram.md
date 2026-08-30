# CodeShell Runtime Architecture Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 Archify 生成一张源码可核验的 CodeShell 整体运行时架构图，并交付 JSON IR、可交互 HTML 与视觉检查证据。

**Architecture:** 使用 Archify `architecture` 类型和 `showcase` 质量档，将 CodeShell 表达为入口、宿主/传输、核心编排、可选能力、执行集成与外部模型六层。图中只保留一条明显主链路和少量侧支，所有节点与关系以当前仓库架构文档及 package 边界为依据。

**Tech Stack:** Node.js 25、Archify v2.16.0、typed JSON IR、standalone HTML/SVG、Chromium visual-check。

## Global Constraints

- 图形类型必须是 `architecture`，质量档必须是 `showcase`。
- 主要文案使用中文；package、协议、命令、产品名保持原文。
- 使用默认 Classic preset，不启用动画。
- 主要节点控制在 10–12 个；主路径必须一眼可辨。
- Core 必须保持 UI 无关、领域无关；Coding、Arena、Pet 必须画成可选能力。
- 不把 `packages/web` 误画成完整独立 UI，不把 `packages/server` 误画成已完成账号网关。
- 最终校验必须为 9 项 artifact checks、0 composition errors、0 warnings。
- 最终视觉检查必须覆盖 1440×900、1600×1000、1920×1080、2048×1320。

---

## File Structure

- Create: `docs/architecture/archify/codeshell-runtime-overview.architecture.json` — Archify 强类型架构源。
- Create: `docs/architecture/archify/codeshell-runtime-overview.architecture.html` — 最终 standalone Viewer。
- Generate beside HTML: Archify visual-check JSON sidecars、明暗主题截图及 contact sheet — 视觉验收证据。
- Do not modify: `.agents/skills/archify/**` — 已安装的第三方 Skill 运行时。

### Task 1: Author and validate the typed architecture source

**Files:**
- Create: `docs/architecture/archify/codeshell-runtime-overview.architecture.json`
- Reference: `.agents/skills/archify/schemas/common.schema.json`
- Reference: `.agents/skills/archify/schemas/architecture.schema.json`
- Reference: `.agents/skills/archify/examples/architecture.json`
- Reference: `docs/architecture/00-overview.md`
- Reference: `docs/architecture/12-package-boundaries-and-release-units.md`

**Interfaces:**
- Consumes: Archify architecture schema and current CodeShell package/runtime facts.
- Produces: A schema-valid architecture JSON source with stable IDs, Chinese authored copy, `meta.quality_profile: "showcase"`, and no more than 12 primary nodes.

- [ ] **Step 1: Read only the required Archify schema and example files**

Read the common schema, architecture schema, and one architecture example. Use the example only for field shape; do not copy its domain facts or IDs.

- [ ] **Step 2: Write the first candidate before inspecting renderer internals**

Create `docs/architecture/archify/codeshell-runtime-overview.architecture.json` with:

- User-facing entry nodes for Desktop, TUI, and Web / Remote.
- Host/transport nodes for Desktop Host and Server / Chat transport.
- One emphasized Core Engine node.
- Optional Coding, Arena, and Pet capability nodes.
- One integration node for Link / CDP / MCP / CLI Agent.
- One external LLM Providers node.
- A clear request/response main route and sparse, semantic relationship labels.

Do not add manual routing controls until a validator diagnostic requires one.

- [ ] **Step 3: Run the one-time packaged update checker**

Run:

```bash
node .agents/skills/archify/scripts/check-update.mjs
```

Expected: checker completes; continue regardless of a non-security update notice without changing the installed Skill.

- [ ] **Step 4: Validate the candidate**

Run:

```bash
node .agents/skills/archify/bin/archify.mjs validate architecture docs/architecture/archify/codeshell-runtime-overview.architecture.json --quality showcase --json
```

Expected: 9 artifact checks, 0 composition errors, 0 warnings. If validation fails, change only the diagnosed subject and rerun; stop after two consecutive repairs fail to improve the best objective error count.

- [ ] **Step 5: Check the source diff**

Run:

```bash
git diff --check -- docs/architecture/archify/codeshell-runtime-overview.architecture.json
```

Expected: exit 0 with no whitespace errors.

### Task 2: Deliver and visually verify the standalone artifact

**Files:**
- Consume: `docs/architecture/archify/codeshell-runtime-overview.architecture.json`
- Create: `docs/architecture/archify/codeshell-runtime-overview.architecture.html`
- Generate: visual-check screenshots, contact sheet, and JSON receipts beside the HTML.

**Interfaces:**
- Consumes: The final validation-frozen JSON bytes from Task 1.
- Produces: An atomically delivered HTML artifact plus SHA-256 receipts and bounded desktop visual evidence.

- [ ] **Step 1: Deliver the validated source exactly once**

Run:

```bash
node .agents/skills/archify/bin/archify.mjs deliver architecture docs/architecture/archify/codeshell-runtime-overview.architecture.json docs/architecture/archify/codeshell-runtime-overview.architecture.html --quality showcase --json
```

Expected: exit 0 and a JSON receipt containing specification/artifact SHA-256 and byte counts. Do not edit the JSON after this command.

- [ ] **Step 2: Run bounded desktop visual checks**

Run:

```bash
node .agents/skills/archify/bin/archify.mjs visual-check docs/architecture/archify/codeshell-runtime-overview.architecture.html --json
```

Expected: exit 0, no horizontal or vertical overflow at 1440×900, 1600×1000, 1920×1080, and 2048×1320; `visualReview` remains truthfully `pending` until screenshots are inspected.

- [ ] **Step 3: Inspect the contact sheet and representative screenshots**

Open the generated contact sheet plus the smallest and largest light/dark screenshots. Confirm labels are readable, the main path is obvious, no route crosses an unrelated opaque node, and the largest viewport has no conspicuous empty lower band.

- [ ] **Step 4: Run final verification**

Run:

```bash
git diff --check -- docs/architecture/archify
```

Expected: exit 0. Verify the HTML exists and the validation/delivery/visual-check receipts all correspond to the same frozen specification.

- [ ] **Step 5: Commit the generated artifacts**

Run affected checks before committing, then run:

```bash
git add docs/architecture/archify docs/superpowers/plans/2026-08-31-codeshell-runtime-architecture-diagram.md
git commit -m "docs: add interactive CodeShell architecture map"
```

Expected: one commit containing only the plan and Archify output artifacts; third-party Skill installation files remain uncommitted.
