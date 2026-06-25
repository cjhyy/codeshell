import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("./images/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const palette = {
  bg: "#f8fafc",
  panel: "#ffffff",
  ink: "#0f172a",
  muted: "#475569",
  line: "#334155",
  blue: "#2563eb",
  cyan: "#0891b2",
  green: "#16a34a",
  amber: "#d97706",
  red: "#dc2626",
  violet: "#7c3aed",
  slate: "#64748b",
  pink: "#db2777",
};

const fills = {
  blue: ["#dbeafe", "#1d4ed8"],
  cyan: ["#cffafe", "#0e7490"],
  green: ["#dcfce7", "#15803d"],
  amber: ["#fef3c7", "#b45309"],
  red: ["#fee2e2", "#b91c1c"],
  violet: ["#ede9fe", "#6d28d9"],
  slate: ["#e2e8f0", "#334155"],
  pink: ["#fce7f3", "#be185d"],
  white: ["#ffffff", "#334155"],
};

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function lines(text) {
  return String(text).split("\n");
}

function box(n) {
  const [fill, stroke] = fills[n.color ?? "white"] ?? fills.white;
  const rx = n.rx ?? 10;
  const titleLines = lines(n.label);
  const captionLines = n.caption ? lines(n.caption) : [];
  const titleStartY = n.y + (captionLines.length ? 28 : Math.max(35, n.h / 2 - (titleLines.length - 1) * 10));
  const capStartY = titleStartY + titleLines.length * 20 + 8;
  return `
    <g id="${esc(n.id)}">
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
      ${titleLines
        .map(
          (line, i) =>
            `<text x="${n.x + n.w / 2}" y="${titleStartY + i * 21}" text-anchor="middle" class="box-title">${esc(line)}</text>`,
        )
        .join("")}
      ${captionLines
        .map(
          (line, i) =>
            `<text x="${n.x + n.w / 2}" y="${capStartY + i * 17}" text-anchor="middle" class="box-caption">${esc(line)}</text>`,
        )
        .join("")}
    </g>`;
}

function group(g) {
  return `
    <g>
      <rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="16" fill="${g.fill ?? "#ffffff"}" stroke="${g.stroke ?? "#cbd5e1"}" stroke-width="2" stroke-dasharray="${g.dash ?? "8 8"}"/>
      <text x="${g.x + 18}" y="${g.y + 28}" class="group-title">${esc(g.label)}</text>
    </g>`;
}

function center(n) {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

function side(n, dir) {
  if (dir === "left") return { x: n.x, y: n.y + n.h / 2 };
  if (dir === "right") return { x: n.x + n.w, y: n.y + n.h / 2 };
  if (dir === "top") return { x: n.x + n.w / 2, y: n.y };
  if (dir === "bottom") return { x: n.x + n.w / 2, y: n.y + n.h };
  return center(n);
}

function edge(nodesById, e) {
  const a = nodesById.get(e.from);
  const b = nodesById.get(e.to);
  if (!a || !b) throw new Error(`bad edge: ${e.from} -> ${e.to}`);
  const p1 = side(a, e.fromSide ?? "right");
  const p2 = side(b, e.toSide ?? "left");
  const color = e.color ?? palette.line;
  const label = e.label
    ? `<text x="${(p1.x + p2.x) / 2}" y="${(p1.y + p2.y) / 2 - 8}" text-anchor="middle" class="edge-label">${esc(e.label)}</text>`
    : "";
  const path = e.mode === "straight"
    ? `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`
    : `M ${p1.x} ${p1.y} C ${(p1.x + p2.x) / 2} ${p1.y}, ${(p1.x + p2.x) / 2} ${p2.y}, ${p2.x} ${p2.y}`;
  return `
    <path d="${path}" fill="none" stroke="${color}" stroke-width="${e.width ?? 2.4}" marker-end="url(#arrow)"/>
    ${label}`;
}

function note(n) {
  return `
    <g>
      <text x="${n.x}" y="${n.y}" class="note-title">${esc(n.title)}</text>
      ${lines(n.text)
        .map((line, i) => `<text x="${n.x}" y="${n.y + 22 + i * 18}" class="note">${esc(line)}</text>`)
        .join("")}
    </g>`;
}

function render(diagram) {
  const nodesById = new Map(diagram.nodes.map((n) => [n.id, n]));
  const body = [
    ...(diagram.groups ?? []).map(group),
    ...diagram.edges.map((e) => edge(nodesById, e)),
    ...diagram.nodes.map(box),
    ...(diagram.notes ?? []).map(note),
  ].join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${diagram.width}" height="${diagram.height}" viewBox="0 0 ${diagram.width} ${diagram.height}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(diagram.title)}</title>
  <desc id="desc">${esc(diagram.subtitle ?? diagram.title)}</desc>
  <defs>
    <marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
      <path d="M2,2 L10,6 L2,10 Z" fill="${palette.line}"/>
    </marker>
    <filter id="shadow" x="-10%" y="-20%" width="120%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#0f172a" flood-opacity="0.10"/>
    </filter>
  </defs>
  <style>
    .title { font: 700 34px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${palette.ink}; }
    .subtitle { font: 500 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${palette.muted}; }
    .box-title { font: 700 19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${palette.ink}; }
    .box-caption { font: 500 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${palette.muted}; }
    .group-title { font: 700 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${palette.slate}; text-transform: uppercase; letter-spacing: 0.04em; }
    .edge-label { font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${palette.muted}; paint-order: stroke; stroke: ${palette.bg}; stroke-width: 5px; }
    .note-title { font: 700 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${palette.ink}; }
    .note { font: 500 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${palette.muted}; }
  </style>
  <rect width="100%" height="100%" fill="${palette.bg}"/>
  <text x="48" y="54" class="title">${esc(diagram.title)}</text>
  <text x="48" y="84" class="subtitle">${esc(diagram.subtitle ?? "")}</text>
  <g filter="url(#shadow)">
  ${body}
  </g>
</svg>
`;
}

const diagrams = [
  {
    file: "00-framework-overview.svg",
    width: 1600,
    height: 980,
    title: "CodeShell 框架粗略介绍图",
    subtitle: "通用 Agent 编排内核 + 终端编码预设 + 长任务与多模型扩展",
    groups: [
      { x: 40, y: 120, w: 320, h: 700, label: "入口" },
      { x: 410, y: 120, w: 410, h: 700, label: "编排核心" },
      { x: 870, y: 120, w: 650, h: 700, label: "能力与基础设施" },
    ],
    nodes: [
      { id: "user", x: 90, y: 180, w: 220, h: 82, label: "用户 / SDK", caption: "CLI、库调用、外部产品", color: "blue" },
      { id: "cli", x: 90, y: 320, w: 220, h: 90, label: "CLI", caption: "repl / run / arena / runs", color: "cyan" },
      { id: "protocol", x: 90, y: 470, w: 220, h: 96, label: "Agent Protocol", caption: "Client / Server\nstream、approval、query", color: "violet" },
      { id: "ui", x: 90, y: 640, w: 220, h: 92, label: "UI / Renderer", caption: "交互 REPL 或 headless 输出", color: "slate" },
      { id: "engine", x: 475, y: 205, w: 270, h: 120, label: "Engine", caption: "连接 prompt、模型、工具、会话", color: "blue" },
      { id: "preset", x: 475, y: 395, w: 270, h: 100, label: "Preset + Prompt", caption: "general / terminal-coding\nsections + instructions", color: "green" },
      { id: "loop", x: 475, y: 575, w: 270, h: 110, label: "TurnLoop", caption: "model_call -> tool_exec\ncontext_mgmt -> next turn", color: "amber" },
      { id: "tools", x: 920, y: 175, w: 240, h: 100, label: "Tool System", caption: "builtin、custom、MCP\npermission + sandbox", color: "red" },
      { id: "llm", x: 1230, y: 175, w: 240, h: 100, label: "LLM Layer", caption: "ModelPool、ProviderCatalog\nOpenAI-compatible / Anthropic", color: "blue" },
      { id: "state", x: 920, y: 360, w: 240, h: 105, label: "State & Storage", caption: "settings、sessions、runs\nlogs、memories", color: "green" },
      { id: "run", x: 1230, y: 360, w: 240, h: 105, label: "RunManager", caption: "queue、checkpoint\napproval、artifact", color: "cyan" },
      { id: "arena", x: 920, y: 555, w: 240, h: 110, label: "Arena", caption: "多模型 research\nreview、discussion、planning", color: "violet" },
      { id: "product", x: 1230, y: 555, w: 240, h: 110, label: "Product API", caption: "defineProduct\npreset + adapter + contract", color: "pink" },
    ],
    edges: [
      { from: "user", to: "cli", fromSide: "bottom", toSide: "top", label: "启动" },
      { from: "cli", to: "protocol", fromSide: "bottom", toSide: "top", label: "统一请求" },
      { from: "protocol", to: "engine", label: "agent/run" },
      { from: "engine", to: "preset", fromSide: "bottom", toSide: "top" },
      { from: "preset", to: "loop", fromSide: "bottom", toSide: "top" },
      { from: "loop", to: "tools", label: "tool calls" },
      { from: "loop", to: "llm", label: "model calls" },
      { from: "engine", to: "state", label: "persist" },
      { from: "protocol", to: "ui", fromSide: "bottom", toSide: "top", label: "stream events" },
      { from: "engine", to: "run", label: "managed lifecycle" },
      { from: "tools", to: "arena", fromSide: "bottom", toSide: "top", label: "Arena tool" },
      { from: "product", to: "run", fromSide: "top", toSide: "bottom", label: "wraps" },
    ],
    notes: [
      { x: 82, y: 865, title: "一句话", text: "CodeShell 把 Agent 的通用编排能力沉到 Engine / Tool / Context / LLM 内核，\n再用 preset、UI、RunManager、Arena 和 Product API 组合成不同产品形态。" },
    ],
  },
  {
    file: "01-runtime-flow.svg",
    width: 1600,
    height: 920,
    title: "运行流细节图",
    subtitle: "从 CLI 输入到 Engine 多轮执行，再回到终端显示与持久化",
    nodes: [
      { id: "cmd", x: 70, y: 180, w: 190, h: 86, label: "CLI Command", caption: "repl / run / arena", color: "blue" },
      { id: "settings", x: 320, y: 180, w: 210, h: 86, label: "Settings + Auth", caption: "配置合并、onboarding\n模型/API key", color: "green" },
      { id: "transport", x: 590, y: 180, w: 220, h: 86, label: "AgentClient / Server", caption: "in-process JSON-RPC\ncancel / query / approve", color: "violet" },
      { id: "engine", x: 880, y: 180, w: 190, h: 86, label: "Engine.run", caption: "创建 ToolContext\nsession + prompt", color: "blue" },
      { id: "turn", x: 1130, y: 180, w: 200, h: 86, label: "TurnLoop", caption: "循环直到完成", color: "amber" },
      { id: "done", x: 1390, y: 180, w: 150, h: 86, label: "Result", caption: "text + reason", color: "slate" },
      { id: "model", x: 995, y: 370, w: 210, h: 92, label: "ModelFacade", caption: "streaming\nfallback / usage", color: "cyan" },
      { id: "tool", x: 995, y: 540, w: 210, h: 92, label: "ToolExecutor", caption: "permission\nhooks / sandbox", color: "red" },
      { id: "context", x: 730, y: 540, w: 210, h: 92, label: "ContextManager", caption: "compact / persist\nlarge tool results", color: "green" },
      { id: "session", x: 470, y: 540, w: 210, h: 92, label: "SessionManager", caption: "state.json\ntranscript.jsonl", color: "violet" },
      { id: "stream", x: 730, y: 710, w: 210, h: 88, label: "Stream Events", caption: "text_delta\ntool_result / usage", color: "pink" },
      { id: "renderer", x: 470, y: 710, w: 210, h: 88, label: "Renderer", caption: "REPL UI\nor headless output", color: "slate" },
    ],
    edges: [
      { from: "cmd", to: "settings" },
      { from: "settings", to: "transport" },
      { from: "transport", to: "engine" },
      { from: "engine", to: "turn" },
      { from: "turn", to: "done" },
      { from: "turn", to: "model", fromSide: "bottom", toSide: "top", label: "model_call" },
      { from: "turn", to: "tool", fromSide: "bottom", toSide: "top", label: "tool_exec" },
      { from: "tool", to: "context", toSide: "right", label: "tool results" },
      { from: "context", to: "session", toSide: "right", label: "messages" },
      { from: "turn", to: "stream", fromSide: "bottom", toSide: "top", label: "onStream" },
      { from: "stream", to: "renderer", toSide: "right", label: "display" },
      { from: "session", to: "renderer", fromSide: "bottom", toSide: "top", label: "resume/list" },
    ],
  },
  {
    file: "02-engine-turn-loop.svg",
    width: 1600,
    height: 980,
    title: "Engine 与 TurnLoop 细节图",
    subtitle: "Engine 负责装配，TurnLoop 负责多轮状态机",
    groups: [
      { x: 70, y: 135, w: 500, h: 710, label: "Engine.run 装配区" },
      { x: 660, y: 135, w: 850, h: 710, label: "TurnLoop 循环区" },
    ],
    nodes: [
      { id: "input", x: 120, y: 190, w: 190, h: 78, label: "User Task", caption: "task + optional sessionId", color: "blue" },
      { id: "ctx", x: 340, y: 190, w: 180, h: 78, label: "ToolContext", caption: "cwd、LLM、sandbox\naskUser、subAgent", color: "green" },
      { id: "session", x: 120, y: 330, w: 190, h: 82, label: "Session", caption: "create / resume\nappend user msg", color: "violet" },
      { id: "perm", x: 340, y: 330, w: 180, h: 82, label: "Permission", caption: "rules + backend\ninteractive/headless", color: "red" },
      { id: "prompt", x: 120, y: 475, w: 190, h: 86, label: "PromptComposer", caption: "tools + preset\ninstructions + memory", color: "amber" },
      { id: "deps", x: 340, y: 475, w: 180, h: 86, label: "Deps", caption: "ModelFacade + ToolExecutor\nContextManager", color: "cyan" },
      { id: "turn", x: 235, y: 650, w: 180, h: 88, label: "TurnLoop", caption: "constructed per run", color: "blue" },
      { id: "pre", x: 715, y: 220, w: 170, h: 74, label: "pre_check", caption: "manage context", color: "green" },
      { id: "model", x: 960, y: 220, w: 170, h: 74, label: "model_call", caption: "stream + fallback", color: "blue" },
      { id: "post", x: 1205, y: 220, w: 170, h: 74, label: "post_check", caption: "text or tools?", color: "amber" },
      { id: "complete", x: 1230, y: 390, w: 170, h: 76, label: "complete", caption: "assistant_message", color: "slate" },
      { id: "exec", x: 960, y: 390, w: 170, h: 76, label: "tool_exec", caption: "queue + executor", color: "red" },
      { id: "append", x: 715, y: 390, w: 170, h: 76, label: "append results", caption: "tool_result blocks", color: "violet" },
      { id: "guards", x: 840, y: 565, w: 190, h: 82, label: "guards", caption: "token budget\ninvestigation/task", color: "pink" },
      { id: "compact", x: 1090, y: 565, w: 190, h: 82, label: "context_mgmt", caption: "usage update\ncompact event", color: "green" },
      { id: "recovery", x: 930, y: 725, w: 230, h: 84, label: "recovery paths", caption: "context retry + continuation\norphan tool patch", color: "amber" },
    ],
    edges: [
      { from: "input", to: "ctx" },
      { from: "input", to: "session", fromSide: "bottom", toSide: "top" },
      { from: "ctx", to: "perm", fromSide: "bottom", toSide: "top" },
      { from: "session", to: "prompt", fromSide: "bottom", toSide: "top" },
      { from: "perm", to: "deps", fromSide: "bottom", toSide: "top" },
      { from: "prompt", to: "turn", fromSide: "bottom", toSide: "top" },
      { from: "deps", to: "turn", fromSide: "bottom", toSide: "top" },
      { from: "turn", to: "pre" },
      { from: "pre", to: "model" },
      { from: "model", to: "post" },
      { from: "post", to: "complete", fromSide: "bottom", toSide: "top", label: "no tools" },
      { from: "post", to: "exec", fromSide: "bottom", toSide: "top", label: "tools" },
      { from: "exec", to: "append", toSide: "right" },
      { from: "append", to: "guards", fromSide: "bottom", toSide: "left" },
      { from: "guards", to: "compact" },
      { from: "compact", to: "pre", fromSide: "top", toSide: "bottom", label: "next turn" },
      { from: "model", to: "recovery", fromSide: "bottom", toSide: "top" },
      { from: "recovery", to: "model", fromSide: "top", toSide: "bottom" },
    ],
  },
  {
    file: "03-tool-system.svg",
    width: 1600,
    height: 980,
    title: "Tool System 细节图",
    subtitle: "模型工具调用在这里变成受控的真实操作",
    nodes: [
      { id: "call", x: 70, y: 175, w: 200, h: 82, label: "ToolCall", caption: "name + args + id", color: "blue" },
      { id: "plan", x: 340, y: 135, w: 230, h: 72, label: "Plan Mode Filter", caption: "只允许读/规划工具", color: "green" },
      { id: "validate", x: 340, y: 240, w: 230, h: 72, label: "Arg Validation", caption: "inputSchema", color: "cyan" },
      { id: "hooks1", x: 340, y: 345, w: 230, h: 72, label: "pre_tool_use", caption: "hook 可拒绝", color: "violet" },
      { id: "guards", x: 340, y: 450, w: 230, h: 72, label: "Guards", caption: "重复读取 / stale task", color: "amber" },
      { id: "perm", x: 660, y: 290, w: 230, h: 86, label: "PermissionClassifier", caption: "rules、bash 风险\nask / allow / deny", color: "red" },
      { id: "approve", x: 955, y: 170, w: 230, h: 88, label: "ApprovalBackend", caption: "interactive\nheadless / auto", color: "pink" },
      { id: "registry", x: 955, y: 380, w: 230, h: 88, label: "ToolRegistry", caption: "builtin + custom + MCP\nexecutor lookup", color: "blue" },
      { id: "builtin", x: 1260, y: 215, w: 230, h: 90, label: "Builtin Tools", caption: "Read、Edit、Bash\nTask、Agent、Skill", color: "green" },
      { id: "mcp", x: 1260, y: 360, w: 230, h: 90, label: "MCP Tools", caption: "mcp_server_tool\nresources", color: "violet" },
      { id: "sandbox", x: 1260, y: 505, w: 230, h: 90, label: "Sandbox", caption: "off / auto\nseatbelt / bwrap", color: "amber" },
      { id: "result", x: 955, y: 630, w: 230, h: 90, label: "ToolResult", caption: "result or error\nrecord + stream", color: "slate" },
      { id: "transcript", x: 660, y: 630, w: 230, h: 90, label: "Transcript", caption: "tool_use\ntool_result", color: "cyan" },
      { id: "stream", x: 340, y: 630, w: 230, h: 90, label: "Stream Event", caption: "tool_use_start\ntool_result", color: "pink" },
    ],
    edges: [
      { from: "call", to: "plan" },
      { from: "plan", to: "validate", fromSide: "bottom", toSide: "top" },
      { from: "validate", to: "hooks1", fromSide: "bottom", toSide: "top" },
      { from: "hooks1", to: "guards", fromSide: "bottom", toSide: "top" },
      { from: "guards", to: "perm" },
      { from: "perm", to: "approve", fromSide: "top", toSide: "left", label: "ask" },
      { from: "approve", to: "perm", fromSide: "bottom", toSide: "top", label: "decision" },
      { from: "perm", to: "registry", label: "allow" },
      { from: "registry", to: "builtin", toSide: "left" },
      { from: "registry", to: "mcp", toSide: "left" },
      { from: "registry", to: "sandbox", toSide: "left", label: "Bash" },
      { from: "registry", to: "result", fromSide: "bottom", toSide: "top" },
      { from: "result", to: "transcript", toSide: "right" },
      { from: "transcript", to: "stream", toSide: "right" },
    ],
    notes: [
      { x: 80, y: 840, title: "并发策略", text: "isConcurrencySafe=true 的读取类工具可并发启动；写入、shell、审批类工具按顺序 drain，\n同时 ToolRegistry 为每次调用加 timeout 与 abort signal。" },
    ],
  },
  {
    file: "04-state-config-storage.svg",
    width: 1600,
    height: 980,
    title: "状态、配置与存储细节图",
    subtitle: "CodeShell 的运行状态主要是文件系统可恢复状态",
    nodes: [
      { id: "sources", x: 70, y: 155, w: 260, h: 105, label: "Settings Sources", caption: "managed -> user -> project\n-> local -> flags", color: "green" },
      { id: "schema", x: 410, y: 155, w: 230, h: 105, label: "Settings Schema", caption: "agent、model、context\npermissions、sandbox", color: "blue" },
      { id: "engine", x: 720, y: 155, w: 220, h: 105, label: "Engine Config", caption: "LLM、preset、tools\nmcp、session dir", color: "violet" },
      { id: "session", x: 1050, y: 135, w: 240, h: 90, label: "Session Store", caption: "~/.code-shell/sessions", color: "cyan" },
      { id: "state", x: 1320, y: 135, w: 200, h: 90, label: "state.json", caption: "status、usage\nturnCount", color: "slate" },
      { id: "transcript", x: 1320, y: 270, w: 200, h: 90, label: "transcript.jsonl", caption: "message、tool_use\nturn_boundary", color: "slate" },
      { id: "toolres", x: 1320, y: 405, w: 200, h: 90, label: "tool-results/", caption: "大结果落盘\npreview 入上下文", color: "slate" },
      { id: "context", x: 720, y: 380, w: 240, h: 108, label: "ContextManager", caption: "persist -> truncate\nmicro -> summary\nsnip/window/emergency", color: "amber" },
      { id: "runs", x: 70, y: 585, w: 260, h: 110, label: "Run Store", caption: "~/.code-shell/runs\nrun.json + events.jsonl\ncheckpoints / approvals", color: "pink" },
      { id: "logs", x: 410, y: 585, w: 230, h: 110, label: "Logs", caption: "engine-YYYY-MM-DD\nui-ink-YYYY-MM-DD\nsid 贯穿", color: "red" },
      { id: "memory", x: 720, y: 585, w: 240, h: 110, label: "Memory", caption: "project/user memories\nsession summary\nauto-dream", color: "green" },
      { id: "cache", x: 1050, y: 585, w: 240, h: 110, label: "Model Cache", caption: "provider model list\ncontextLength\nsync-models", color: "blue" },
    ],
    edges: [
      { from: "sources", to: "schema" },
      { from: "schema", to: "engine" },
      { from: "engine", to: "session" },
      { from: "session", to: "state" },
      { from: "session", to: "transcript", fromSide: "right", toSide: "left" },
      { from: "context", to: "toolres", label: "persist large result" },
      { from: "context", to: "transcript", fromSide: "right", toSide: "left", label: "compact markers" },
      { from: "engine", to: "context", fromSide: "bottom", toSide: "top" },
      { from: "engine", to: "logs", fromSide: "bottom", toSide: "top", label: "JSONL traces" },
      { from: "engine", to: "memory", fromSide: "bottom", toSide: "top", label: "post-session" },
      { from: "schema", to: "cache", fromSide: "bottom", toSide: "top", label: "models/providers" },
      { from: "engine", to: "runs", fromSide: "bottom", toSide: "top", label: "managed runs" },
    ],
  },
  {
    file: "05-ui-protocol-rendering.svg",
    width: 1600,
    height: 980,
    title: "UI、协议与渲染细节图",
    subtitle: "交互层通过协议隔离 Engine，并使用项目内自研 Ink-like renderer",
    groups: [
      { x: 60, y: 130, w: 470, h: 650, label: "UI App" },
      { x: 590, y: 130, w: 360, h: 650, label: "Protocol" },
      { x: 1010, y: 130, w: 500, h: 650, label: "Runtime + Renderer" },
    ],
    nodes: [
      { id: "input", x: 110, y: 190, w: 180, h: 78, label: "CommandInput", caption: "用户输入 / slash", color: "blue" },
      { id: "registry", x: 315, y: 190, w: 170, h: 78, label: "CommandRegistry", caption: "/model /resume\n/compact ...", color: "green" },
      { id: "app", x: 190, y: 330, w: 220, h: 90, label: "App.tsx", caption: "run state、session、model\napproval、panels", color: "violet" },
      { id: "store", x: 110, y: 500, w: 180, h: 84, label: "chatStore", caption: "useSyncExternalStore\nstreaming entries", color: "cyan" },
      { id: "views", x: 315, y: 500, w: 170, h: 84, label: "UI Components", caption: "MessageList\nToolCall\nStatusLine", color: "slate" },
      { id: "client", x: 650, y: 230, w: 230, h: 86, label: "AgentClient", caption: "run / approve\ncancel / query", color: "blue" },
      { id: "transport", x: 650, y: 390, w: 230, h: 86, label: "Transport", caption: "in-process\nor stdio JSONL", color: "amber" },
      { id: "server", x: 650, y: 550, w: 230, h: 86, label: "AgentServer", caption: "pending approvals\nstream forwarding", color: "violet" },
      { id: "engine", x: 1070, y: 230, w: 190, h: 86, label: "Engine", caption: "run task", color: "blue" },
      { id: "stream", x: 1290, y: 230, w: 170, h: 86, label: "StreamEvent", caption: "text / tool\nusage / task", color: "pink" },
      { id: "approval", x: 1070, y: 390, w: 190, h: 86, label: "Approval UI", caption: "PermissionPrompt\nAskUserPrompt", color: "red" },
      { id: "render", x: 1290, y: 390, w: 170, h: 86, label: "Renderer", caption: "Box / Text\nScrollBox", color: "green" },
      { id: "terminal", x: 1180, y: 585, w: 190, h: 86, label: "Terminal", caption: "layout、events\nANSI、focus", color: "slate" },
    ],
    edges: [
      { from: "input", to: "app", fromSide: "bottom", toSide: "top" },
      { from: "registry", to: "app", fromSide: "bottom", toSide: "top" },
      { from: "app", to: "client" },
      { from: "client", to: "transport", fromSide: "bottom", toSide: "top" },
      { from: "transport", to: "server", fromSide: "bottom", toSide: "top" },
      { from: "server", to: "engine" },
      { from: "engine", to: "stream" },
      { from: "stream", to: "client", fromSide: "left", toSide: "right", label: "notifications" },
      { from: "client", to: "app", fromSide: "left", toSide: "right", label: "events" },
      { from: "app", to: "store", fromSide: "bottom", toSide: "top" },
      { from: "store", to: "views" },
      { from: "views", to: "render" },
      { from: "approval", to: "server", fromSide: "left", toSide: "right", label: "approve" },
      { from: "server", to: "approval", fromSide: "right", toSide: "left", label: "request" },
      { from: "render", to: "terminal", fromSide: "bottom", toSide: "top" },
    ],
  },
  {
    file: "06-llm-model-layer.svg",
    width: 1600,
    height: 980,
    title: "LLM 与模型层细节图",
    subtitle: "ModelPool 负责选择模型，Provider 客户端负责统一不同 API 形状",
    nodes: [
      { id: "settings", x: 70, y: 170, w: 230, h: 92, label: "settings", caption: "activeKey\nproviders[]\nmodels[]", color: "green" },
      { id: "catalog", x: 370, y: 145, w: 230, h: 90, label: "ProviderCatalog", caption: "kind、baseUrl\napiKey、thinking", color: "cyan" },
      { id: "pool", x: 370, y: 290, w: 230, h: 96, label: "ModelPool", caption: "register / switch / get\ncontext window cache", color: "blue" },
      { id: "config", x: 680, y: 220, w: 220, h: 96, label: "LLMConfig", caption: "provider、model\nbaseUrl、maxTokens\nproviderKind", color: "violet" },
      { id: "factory", x: 980, y: 220, w: 220, h: 96, label: "Client Factory", caption: "openai or anthropic\nregisterProvider", color: "amber" },
      { id: "openai", x: 1280, y: 130, w: 230, h: 96, label: "OpenAIClient", caption: "OpenAI-compatible\nDeepSeek、OpenRouter\nZ.AI、Groq、xAI...", color: "blue" },
      { id: "anthropic", x: 1280, y: 290, w: 230, h: 96, label: "AnthropicClient", caption: "Anthropic SDK\nmessages + tools", color: "green" },
      { id: "cap", x: 980, y: 455, w: 220, h: 104, label: "Capabilities", caption: "max_tokens 字段\nreasoning shape\nrejected params", color: "red" },
      { id: "facade", x: 680, y: 455, w: 220, h: 104, label: "ModelFacade", caption: "stream / fallback\nsummarize\nusage accounting", color: "cyan" },
      { id: "turn", x: 370, y: 500, w: 230, h: 86, label: "TurnLoop", caption: "model_call\ncontinuation", color: "amber" },
      { id: "usage", x: 680, y: 660, w: 220, h: 88, label: "Usage + Cost", caption: "tokens、latency\nctx bar、cost store", color: "pink" },
      { id: "arena", x: 980, y: 660, w: 220, h: 88, label: "Arena Participants", caption: "pool key -> preset\n-> raw model path", color: "violet" },
      { id: "cache", x: 70, y: 500, w: 230, h: 86, label: "Model Cache", caption: "fetchModelList\ncontextLength", color: "slate" },
    ],
    edges: [
      { from: "settings", to: "catalog" },
      { from: "settings", to: "pool", fromSide: "right", toSide: "left" },
      { from: "catalog", to: "pool", fromSide: "bottom", toSide: "top" },
      { from: "pool", to: "config" },
      { from: "config", to: "factory" },
      { from: "factory", to: "openai" },
      { from: "factory", to: "anthropic" },
      { from: "openai", to: "cap", fromSide: "bottom", toSide: "right" },
      { from: "cap", to: "facade", toSide: "right" },
      { from: "facade", to: "turn", toSide: "right" },
      { from: "facade", to: "usage", fromSide: "bottom", toSide: "top" },
      { from: "pool", to: "arena", fromSide: "bottom", toSide: "left", label: "participants" },
      { from: "cache", to: "pool", label: "context windows" },
    ],
  },
  {
    file: "07-run-product-lifecycle.svg",
    width: 1600,
    height: 980,
    title: "RunManager 与 Product API 细节图",
    subtitle: "把一次 Engine.run 封装成长任务生命周期和领域产品",
    nodes: [
      { id: "product", x: 80, y: 170, w: 240, h: 110, label: "defineProduct()", caption: "external repo\n组装领域 agent", color: "pink" },
      { id: "preset", x: 390, y: 120, w: 220, h: 90, label: "ProductPreset", caption: "sections / prompt\ninjectGitStatus", color: "green" },
      { id: "adapter", x: 390, y: 255, w: 220, h: 90, label: "ProductAdapter", caption: "custom tools\nMCP、hooks、rules", color: "blue" },
      { id: "contract", x: 390, y: 390, w: 220, h: 90, label: "ProductContract", caption: "evaluator\ntags、metadata\nlimits", color: "amber" },
      { id: "manager", x: 700, y: 240, w: 230, h: 105, label: "RunManager", caption: "submit / start\nresume / cancel\nattach", color: "violet" },
      { id: "queue", x: 1010, y: 120, w: 210, h: 86, label: "RunQueue", caption: "concurrency\npending / active", color: "cyan" },
      { id: "store", x: 1010, y: 250, w: 210, h: 86, label: "FileRunStore", caption: "run.json\nevents.jsonl", color: "slate" },
      { id: "approval", x: 1010, y: 380, w: 210, h: 86, label: "Approvals", caption: "waiting_approval\nresume decision", color: "red" },
      { id: "checkpoint", x: 1010, y: 510, w: 210, h: 86, label: "Checkpoints", caption: "phase、summary\nnextAction", color: "green" },
      { id: "runner", x: 1310, y: 250, w: 220, h: 100, label: "EngineRunner", caption: "build EngineConfig\nregister custom tools", color: "blue" },
      { id: "engine", x: 1310, y: 430, w: 220, h: 100, label: "Engine.run", caption: "linked session\nstream events", color: "amber" },
      { id: "states", x: 640, y: 620, w: 340, h: 125, label: "Run State Machine", caption: "queued -> running\nwaiting_input / waiting_approval / blocked\ncompleted / failed / cancelled", color: "slate" },
    ],
    edges: [
      { from: "product", to: "preset" },
      { from: "product", to: "adapter" },
      { from: "product", to: "contract" },
      { from: "preset", to: "manager" },
      { from: "adapter", to: "manager" },
      { from: "contract", to: "manager" },
      { from: "manager", to: "queue" },
      { from: "manager", to: "store" },
      { from: "manager", to: "approval" },
      { from: "manager", to: "checkpoint" },
      { from: "queue", to: "runner" },
      { from: "runner", to: "engine", fromSide: "bottom", toSide: "top" },
      { from: "engine", to: "manager", fromSide: "left", toSide: "right", label: "stream/result" },
      { from: "manager", to: "states", fromSide: "bottom", toSide: "top" },
    ],
  },
  {
    file: "08-arena-extension-points.svg",
    width: 1600,
    height: 980,
    title: "Arena 与扩展点细节图",
    subtitle: "多模型证据驱动分析，以及框架可插拔能力",
    groups: [
      { x: 60, y: 130, w: 1010, h: 600, label: "Arena Pipeline" },
      { x: 1130, y: 130, w: 390, h: 600, label: "Extension Points" },
    ],
    nodes: [
      { id: "topic", x: 100, y: 195, w: 170, h: 72, label: "Topic", caption: "自然语言请求", color: "blue" },
      { id: "planner", x: 320, y: 195, w: 170, h: 72, label: "Planner", caption: "mode / lenses / sources", color: "green" },
      { id: "evidence", x: 540, y: 195, w: 170, h: 72, label: "Evidence", caption: "git / repo / docs / web", color: "cyan" },
      { id: "strategy", x: 760, y: 195, w: 170, h: 72, label: "Strategy + Lens", caption: "review / discussion / planning", color: "violet" },
      { id: "research", x: 210, y: 365, w: 190, h: 86, label: "Participant Research", caption: "多模型并行\n独立 dossier", color: "amber" },
      { id: "claims", x: 470, y: 365, w: 190, h: 86, label: "Claim Registry", caption: "findings -> claims\nledger", color: "pink" },
      { id: "review", x: 730, y: 365, w: 190, h: 86, label: "Cross Review", caption: "agree / refine\ndisagree / needs_evidence", color: "red" },
      { id: "debate", x: 330, y: 540, w: 190, h: 86, label: "Debate", caption: "contested claims\nstructured rounds", color: "violet" },
      { id: "adjudicate", x: 590, y: 540, w: 190, h: 86, label: "Adjudication", caption: "verified / rejected\nunresolved", color: "green" },
      { id: "consensus", x: 850, y: 540, w: 170, h: 86, label: "Consensus", caption: "final report\nroadmap / verdict", color: "blue" },
      { id: "presets", x: 1175, y: 190, w: 290, h: 70, label: "Presets", caption: "general / terminal-coding / custom", color: "green" },
      { id: "skills", x: 1175, y: 300, w: 290, h: 70, label: "Skills", caption: ".code-shell/skills + builtins", color: "cyan" },
      { id: "mcp", x: 1175, y: 410, w: 290, h: 70, label: "MCP / Custom Tools", caption: "external capabilities", color: "violet" },
      { id: "hooks", x: 1175, y: 520, w: 290, h: 70, label: "Hooks", caption: "pre/post tool, turn events", color: "amber" },
      { id: "product", x: 1175, y: 630, w: 290, h: 70, label: "Product API", caption: "preset + adapter + contract", color: "pink" },
    ],
    edges: [
      { from: "topic", to: "planner" },
      { from: "planner", to: "evidence" },
      { from: "evidence", to: "strategy" },
      { from: "strategy", to: "research", fromSide: "bottom", toSide: "top" },
      { from: "research", to: "claims" },
      { from: "claims", to: "review" },
      { from: "review", to: "debate", fromSide: "bottom", toSide: "top" },
      { from: "debate", to: "adjudicate" },
      { from: "adjudicate", to: "consensus" },
      { from: "mcp", to: "evidence", fromSide: "left", toSide: "right", label: "tools" },
      { from: "presets", to: "strategy", fromSide: "left", toSide: "right", label: "prompt" },
      { from: "hooks", to: "review", fromSide: "left", toSide: "right", label: "policy" },
      { from: "product", to: "presets", fromSide: "top", toSide: "bottom" },
      { from: "skills", to: "strategy", fromSide: "left", toSide: "right", label: "guidance" },
    ],
  },
];

for (const diagram of diagrams) {
  writeFileSync(join(outDir, diagram.file), render(diagram), "utf8");
}

console.log(`Generated ${diagrams.length} SVG diagrams in ${outDir}`);
