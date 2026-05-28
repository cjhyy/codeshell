import { generateImageTool } from "../packages/core/dist/tool-system/builtin/generate-image.js";

const prompt = `Create a polished technical architecture diagram image for the CodeShell packages/core module. Modern SaaS architecture infographic, dark navy background, clean rounded rectangles, subtle gradients, thin glowing connector lines, high readability, landscape 3:2, professional engineering presentation style, no logos, no watermark.

Title text at top: "CodeShell Core Architecture"

Show a layered architecture with these groups and exact labels:

Top layer: "Entry & Product Layer" with boxes: "TUI / CLI", "SDK / Protocol Clients", "Product Definitions", "Presets", "Run Manager", "Arena".

Center layer, largest and visually central: "Core Runtime" with boxes: "Engine", "TurnLoop", "EngineRuntime", "ModelFacade", "Task Parser", "Stream Event Adapter".

Left supporting layer: "Context System" with boxes: "Context Manager", "Compaction", "Tool Result Storage", "Token Budget".

Right supporting layer: "Session System" with boxes: "Session Manager", "Transcript", "Memory", "File History".

Lower layer: "Tool & Extension Layer" with boxes: "Tool Registry", "Tool Executor", "Permission Classifier", "Sandbox", "Built-in Tools", "MCP Manager", "LSP", "Plugins", "Hooks", "Skills".

LLM layer connected to Core Runtime: "LLM Layer" with boxes: "ModelPool", "Provider Catalog", "OpenAI-compatible Provider", "Anthropic Provider", "Capabilities", "Retry / Stream Watchdog", "Model Catalogs".

Bottom persistence layer: "Persistence & Services" with boxes: "Settings Manager", "Logging", "Cost Tracker", "State", "Run Store", "Analytics", "Diagnostics", "Notifier", "Updater", "Onboarding".

Important arrows:
- Entry & Product Layer calls Protocol Server and Run Manager
- Product Layer calls Engine
- Protocol Server calls Engine
- Engine calls LLM Layer
- Engine calls Tool Executor
- Tool Executor calls Built-in Tools, MCP, LSP, Plugins, Hooks, Skills
- Engine reads and writes Context System and Session System
- Context persists large tool results
- Session writes Transcript and Memory
- Settings feeds Engine, Tools, Plugins, MCP, and LLM
- Logging, Cost Tracker, and State observe Engine and LLM

Add small amber risk callout badges:
- "Engine is overloaded"
- "File tools need PathPolicy"
- "Protocol secrets must be redacted"
- "Plugin / Hook / MCP trust boundary"

Visual style: museum-grade systems cartography, precise grid, elegant spacing, cyan/blue/violet/green/amber accents, thin typography, master-level craftsmanship, dense but not cluttered. Keep all text crisp, centered, readable, and inside boxes. No misspellings. No extra fictional components.`;

const result = await generateImageTool(
  { prompt, size: "1536x1024", quality: "high" },
  { cwd: process.cwd() },
);
console.log(result);
