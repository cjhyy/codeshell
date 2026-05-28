const fs = require("fs");
const path = require("path");

const outDir = path.resolve(__dirname, "../docs/architecture");
const svgPath = path.join(outDir, "core-architecture.svg");

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function panel(x, y, w, h, title, subtitle, color) {
  return `
  <g filter="url(#softGlow)">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28" fill="url(#panelGrad)" stroke="${color}" stroke-opacity="0.72" stroke-width="1.6"/>
    <text x="${x + 30}" y="${y + 48}" class="panelTitle" fill="${color}">${esc(title)}</text>
    <text x="${x + 30}" y="${y + 78}" class="panelSub">${esc(subtitle)}</text>
  </g>`;
}

function node(x, y, w, h, title, lines, color) {
  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="rgba(6,15,29,0.82)" stroke="rgba(226,241,255,0.18)"/>
    <circle cx="${x + 22}" cy="${y + 26}" r="5" fill="${color}"/>
    <text x="${x + 38}" y="${y + 32}" class="nodeTitle">${esc(title)}</text>
    ${lines.map((line, i) => `<text x="${x + 22}" y="${y + 58 + i * 22}" class="nodeLine">${esc(line)}</text>`).join("\n")}
  </g>`;
}

function line(x1, y1, x2, y2, color, opacity = 0.75) {
  const mx = (x1 + x2) / 2;
  return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="${opacity}" marker-end="url(#arrow)" filter="url(#lineGlow)"/>`;
}

function badge(x, y, text) {
  return `<g>
    <rect x="${x}" y="${y}" width="${text.length * 8 + 38}" height="34" rx="17" fill="rgba(251,191,36,0.12)" stroke="#fbbf24"/>
    <text x="${x + 15}" y="${y + 23}" class="badge">${esc(text)}</text>
  </g>`;
}

const C = {
  cyan: "#67e8f9",
  blue: "#60a5fa",
  violet: "#a78bfa",
  green: "#86efac",
  amber: "#fbbf24",
  rose: "#fb7185",
};

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1500" viewBox="0 0 2400 1500">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="78%">
      <stop offset="0%" stop-color="#10264a"/>
      <stop offset="52%" stop-color="#0b1730"/>
      <stop offset="100%" stop-color="#07111f"/>
    </radialGradient>
    <linearGradient id="panelGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="rgba(20,39,70,0.96)"/>
      <stop offset="100%" stop-color="rgba(9,21,39,0.94)"/>
    </linearGradient>
    <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="#67e8f9" flood-opacity="0.12"/>
    </filter>
    <filter id="lineGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#67e8f9" flood-opacity="0.55"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#67e8f9" opacity="0.8"/>
    </marker>
    <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
      <path d="M 80 0 L 0 0 0 80" fill="none" stroke="#67e8f9" stroke-opacity="0.055" stroke-width="1"/>
    </pattern>
    <style>
      .title { font: 800 58px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; fill: #e5f0ff; }
      .subtitle { font: 400 22px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; fill: #8aa4c7; }
      .micro { font: 400 15px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; fill: #49617f; letter-spacing: 1.8px; }
      .panelTitle { font: 800 26px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; letter-spacing: .8px; }
      .panelSub { font: 400 17px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; fill: #8aa4c7; }
      .nodeTitle { font: 800 18px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; fill: #e5f0ff; }
      .nodeLine { font: 400 14px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; fill: #8aa4c7; }
      .badge { font: 800 15px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; fill: #fbbf24; }
      .legend { font: 400 18px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; fill: #8aa4c7; }
    </style>
  </defs>

  <rect width="2400" height="1500" fill="url(#bg)"/>
  <rect x="80" y="80" width="2240" height="1340" fill="url(#grid)"/>

  <text x="110" y="110" class="title">CodeShell Core Architecture</text>
  <text x="112" y="150" class="subtitle">packages/core · runtime map · execution, tools, context, protocol, extensions</text>
  <text x="112" y="188" class="micro">SYSTEMS CARTOGRAPHY / DEPENDENCY TERRAIN / TRUST BOUNDARIES / ORCHESTRATION FLOW</text>

  ${panel(120, 245, 500, 250, "ENTRY & PRODUCT", "TUI · CLI · SDK · Run · Arena", C.blue)}
  ${panel(720, 250, 960, 380, "CORE RUNTIME", "Engine gravity well · TurnLoop · Runtime", C.cyan)}
  ${panel(1780, 245, 500, 250, "LLM LAYER", "ModelPool · Providers · Capabilities", C.violet)}
  ${panel(120, 620, 560, 320, "CONTEXT & SESSION", "compaction · transcript · memory", C.green)}
  ${panel(1720, 620, 560, 320, "SETTINGS & STATE", "config · logs · cost · services", C.amber)}
  ${panel(300, 1030, 1800, 300, "TOOLS & EXTENSIONS", "registry · executor · permissions · sandbox · plugins · MCP · LSP", C.rose)}

  ${node(160, 340, 190, 100, "TUI / CLI", ["Ink UI", "commands"], C.blue)}
  ${node(380, 340, 200, 100, "Protocol", ["server / client", "chat sessions"], C.blue)}
  ${node(160, 735, 230, 110, "Context", ["manager", "compaction", "token budget"], C.green)}
  ${node(420, 735, 220, 110, "Session", ["transcript", "file history", "memory"], C.green)}

  ${node(820, 345, 270, 120, "Engine", ["run orchestration", "stream events", "sub-agents"], C.cyan)}
  ${node(1135, 345, 240, 120, "TurnLoop", ["message loop", "tool calls", "recovery"], C.cyan)}
  ${node(1420, 345, 210, 120, "Runtime", ["shared deps", "registries", "model facade"], C.cyan)}
  ${node(980, 500, 330, 90, "Prompt Runtime", ["composer · presets · instructions"], C.cyan)}

  ${node(1830, 340, 190, 100, "ModelPool", ["active model", "provider routes"], C.violet)}
  ${node(2040, 340, 200, 100, "Providers", ["OpenAI compat", "Anthropic"], C.violet)}
  ${node(1885, 455, 300, 100, "Capabilities", ["reasoning · tools · vision", "retry · watchdog"], C.violet)}

  ${node(1760, 735, 210, 110, "Settings", ["schema", "manager", "scope"], C.amber)}
  ${node(2000, 735, 230, 110, "Observability", ["logging", "cost", "diagnostics"], C.amber)}
  ${node(1835, 855, 310, 70, "Services", ["analytics · notifier · updater · onboarding"], C.amber)}

  ${node(350, 1135, 210, 100, "Tool Registry", ["builtin tools", "discovery"], C.rose)}
  ${node(600, 1135, 220, 100, "Executor", ["validation", "hooks", "timeouts"], C.rose)}
  ${node(860, 1135, 230, 100, "Permission", ["classifier", "approval", "PathPolicy"], C.rose)}
  ${node(1130, 1135, 210, 100, "Sandbox", ["seatbelt", "bwrap", "safe-spawn"], C.rose)}
  ${node(1380, 1135, 230, 100, "Extensions", ["plugins", "hooks", "skills"], C.rose)}
  ${node(1650, 1135, 210, 100, "MCP / LSP", ["external tools", "language servers"], C.rose)}
  ${node(1895, 1135, 160, 100, "Git", ["worktree", "utils"], C.rose)}

  ${line(580, 390, 820, 390, C.blue)}
  ${line(480, 440, 930, 345, C.blue, 0.5)}
  ${line(1090, 405, 1135, 405, C.cyan)}
  ${line(1375, 405, 1420, 405, C.cyan)}
  ${line(1145, 465, 1135, 500, C.cyan, 0.55)}
  ${line(1310, 545, 1830, 390, C.violet)}
  ${line(1090, 465, 530, 735, C.green, 0.65)}
  ${line(1160, 465, 270, 735, C.green, 0.5)}
  ${line(1500, 465, 1860, 735, C.amber, 0.55)}
  ${line(1010, 465, 710, 1135, C.rose, 0.65)}
  ${line(1180, 590, 970, 1135, C.rose, 0.45)}
  ${line(1320, 590, 1480, 1135, C.rose, 0.45)}
  ${line(1730, 405, 1830, 390, C.violet, 0.6)}
  ${line(640, 790, 1760, 790, C.amber, 0.35)}
  ${line(1720, 1185, 1420, 465, C.rose, 0.35)}

  ${badge(780, 645, "RISK: Engine is overloaded")}
  ${badge(820, 1270, "RISK: File tools need PathPolicy")}
  ${badge(1780, 515, "RISK: provider secrets must be redacted")}
  ${badge(1410, 1270, "RISK: plugin / hook / MCP trust boundary")}

  <rect x="110" y="1350" width="2180" height="80" rx="24" fill="rgba(6,15,29,0.66)" stroke="rgba(226,241,255,0.12)"/>
  <text x="145" y="1398" class="legend">Reading guide: upper layers initiate work · center orchestrates turns · lower layer executes tools · side systems persist context, state, cost, and memory · amber badges mark review findings</text>
</svg>`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(svgPath, svg, "utf8");
console.log(svgPath);
