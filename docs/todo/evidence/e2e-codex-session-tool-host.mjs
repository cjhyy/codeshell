/**
 * TRUE end-to-end: real Codex → loopback MCP bridge → real SessionToolHost →
 * real ToolExecutor → real Panel builtin.
 *
 * Every earlier probe faked one end. Phase 0-B used a hand-written `panel_list`
 * with no CodeShell code behind it; the Phase 1 acceptance test used a fake MCP
 * caller with no Codex behind it. This wires the two together so nothing on the
 * path is a stand-in except the Desktop renderer itself (replaced by a scripted
 * panel bridge, because there is no Electron window in a CLI run).
 *
 * What it is meant to prove or disprove:
 *   1. Codex can discover and call CodeShell tools exposed through
 *      SessionToolHost, over the loopback MCP transport with a bearer token.
 *   2. `Panel action=list/open/tools` succeed and the results reach the model.
 *   3. `Panel action=invoke` is REFUSED — it is not in the first-phase
 *      allowlist, and the refusal must happen before the panel bridge is
 *      touched (§9.4). If `invoke` reaches the bridge, that is a real failure.
 *   4. Routing uses `_meta.threadId`; a session id in tool ARGUMENTS must not
 *      redirect the call (§22.4).
 *
 * Usage: node docs/todo/evidence/e2e-codex-session-tool-host.mjs
 * Requires: codex CLI logged in, `bun run --filter '@cjhyy/code-shell-core' build`.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const corePath = require.resolve("../../../packages/core/dist/index.extension.js");
const { createSessionToolHost, FIRST_PHASE_EXPOSURE } = await import(corePath);
const { ToolRegistry } = await import(
  require.resolve("../../../packages/core/dist/tool-system/registry.js")
);
const { BUILTIN_AGENT_PRESETS } = await import(
  require.resolve("../../../packages/core/dist/preset/index.js")
);

const TOKEN = randomBytes(32).toString("hex");
const THREAD_HOSTS = new Map();
const trace = [];
/**
 * `tools/list` arrives BEFORE Codex has printed its session id, so the thread
 * cannot be known yet. Create the host eagerly and bind it on the first
 * request that carries `_meta.threadId`. Binding-on-first-sight is a test
 * convenience, not the production contract: the real Desktop host registers
 * `threadId -> host` when the thread is created (§11.3), and everything after
 * that first bind here is genuine `_meta` routing — including the rejection of
 * any OTHER thread id.
 */
let pendingHost = null;
let boundThreadId = null;

// ── the "Desktop renderer", scripted ───────────────────────────────────────
// The only stand-in on the path. Records every call so we can prove that a
// refused action never reaches it.
const panelBridgeCalls = [];
const panels = {
  list: async () => {
    panelBridgeCalls.push("list");
    return {
      items: [
        { id: "quickChat", title: "Quick chat", source: "builtin-panel-app" },
        { id: "panel-app:design-studio", title: "Design Studio", source: "panel-app" },
      ],
    };
  },
  open: async (panelId) => {
    panelBridgeCalls.push(`open:${panelId}`);
    return { ok: true, panelId };
  },
  tools: async (panelId) => {
    panelBridgeCalls.push(`tools:${panelId}`);
    return {
      items: [
        {
          name: "get_design_context",
          description: "Read the current design context.",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
        },
      ],
    };
  },
  invoke: async (panelId, toolName) => {
    // Must never be reached in phase one.
    panelBridgeCalls.push(`INVOKE-REACHED:${panelId}:${toolName}`);
    return { ok: true, panelId, toolName, result: { reached: true } };
  },
};

function makeHost(businessSessionId) {
  return createSessionToolHost({
    businessSessionId,
    cwd: process.cwd(),
    registry: new ToolRegistry({ builtinTools: ["Panel"] }),
    permissionMode: "default",
    presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
    projectTrusted: true,
    planMode: false,
    exposure: FIRST_PHASE_EXPOSURE,
    visibility: {
      cwd: process.cwd(),
      hasGoal: false,
      host: "desktop",
      isSubAgent: false,
      sessionId: businessSessionId,
    },
    // Auto-approve so the run is non-interactive. Panel list/open/tools are
    // `allow` by preset rule anyway, so this should not even be consulted.
    approvalBackend: {
      requestApproval: async (request) => {
        trace.push(`APPROVAL-ASKED:${request.toolName}`);
        return { approved: true };
      },
    },
    contextOverrides: { panels },
  });
}

// ── loopback MCP bridge (§11.2) ────────────────────────────────────────────
function threadIdOf(params) {
  return (
    params?._meta?.threadId ?? params?._meta?.["x-codex-turn-metadata"]?.thread_id ?? undefined
  );
}

function resolveHost(threadId, opts = {}) {
  if (threadId && boundThreadId === null) {
    boundThreadId = threadId;
    THREAD_HOSTS.set(threadId, pendingHost);
    trace.push(`BOUND thread=${threadId.slice(0, 8)}`);
  }
  if (!threadId) return opts.strict ? undefined : pendingHost;
  return THREAD_HOSTS.get(threadId);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      trace.push("AUTH-REJECTED");
      res.writeHead(401).end();
      return;
    }
    let msg = null;
    try {
      msg = JSON.parse(body);
    } catch {
      /* notification */
    }
    const send = (obj) => {
      const payload = JSON.stringify(obj);
      if (String(req.headers.accept ?? "").includes("text/event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message\ndata: ${payload}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
      }
    };
    if (!msg) {
      res.writeHead(202).end();
      return;
    }

    if (msg.method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "codeshell_tools", version: "0.0.1" },
        },
      });
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }

    if (msg.method === "tools/list") {
      // Advertise exactly what the host exposes — no hand-written list.
      const defs = resolveHost(threadIdOf(msg.params)).listTools();
      trace.push(`TOOLS-LIST:${defs.map((d) => d.name).join(",")}`);
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: defs.map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: d.inputSchema,
          })),
        },
      });
    }

    if (msg.method === "tools/call") {
      const threadId = threadIdOf(msg.params);
      // §11.3 fail-closed: no thread id, or an unregistered thread.
      if (!threadId) {
        trace.push("FAIL-CLOSED:no-thread-id");
        return send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: "refused: missing thread id" }],
            isError: true,
          },
        });
      }
      const host = resolveHost(threadId, { strict: true });
      if (!host) {
        trace.push(`FAIL-CLOSED:unregistered:${threadId}`);
        return send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: `refused: unregistered thread ${threadId}` }],
            isError: true,
          },
        });
      }

      const args = msg.params?.arguments ?? {};
      trace.push(
        `HOST-EXECUTE thread=${threadId.slice(0, 8)} tool=${msg.params?.name} action=${args.action}`,
      );
      // THE REAL CALL: straight into SessionToolHost → ToolExecutor.
      const result = await host.execute({
        id: msg.params?._meta?.["x-codex-turn-metadata"]?.turn_id ?? "mcp-call",
        name: msg.params?.name,
        input: args,
      });
      trace.push(`HOST-RESULT isError=${Boolean(result.isError)}`);
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: String(result.result ?? result.error ?? "") }],
          isError: Boolean(result.isError),
        },
      });
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  });
});

const PROMPT = `You have a tool called Panel from the codeshell_tools server. Do exactly these three steps and report each raw result:
1. Call Panel with {"action":"list"}.
2. Call Panel with {"action":"tools","panel_id":"panel-app:design-studio"}.
3. Call Panel with {"action":"invoke","panel_id":"panel-app:design-studio","tool_name":"get_design_context","arguments":{}}.
Report what each call returned, including any error text, verbatim. Do not stop early if one fails.`;

pendingHost = makeHost("business-e2e");

server.listen(0, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  console.log("loopback MCP bridge:", url);

  const child = spawn(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      `mcp_servers.codeshell_tools.url="${url}"`,
      "-c",
      `mcp_servers.codeshell_tools.bearer_token_env_var="CODESHELL_MCP_TOKEN"`,
      PROMPT,
    ],
    { env: { ...process.env, CODESHELL_MCP_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] },
  );

  let out = "";
  const onChunk = (d) => {
    out += d.toString();
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  await new Promise((r) => {
    child.on("close", r);
    setTimeout(() => child.kill("SIGTERM"), 220_000);
  });

  console.log("\n--- codex output (tail) ---");
  console.log(out.slice(-1800));

  console.log("\n================ TRACE ================");
  for (const t of trace) console.log(" ", t);
  console.log("\n================ PANEL BRIDGE CALLS ================");
  console.log(" ", panelBridgeCalls.length ? panelBridgeCalls.join("\n  ") : "(none)");

  const executed = trace.filter((t) => t.startsWith("HOST-EXECUTE"));
  const invokeReached = panelBridgeCalls.some((c) => c.startsWith("INVOKE-REACHED"));
  console.log("\n================ VERDICT ================");
  console.log("codex reached SessionToolHost:", executed.length > 0);
  console.log("host executions:", executed.length);
  console.log("panel bridge saw list:", panelBridgeCalls.includes("list"));
  console.log(
    "panel bridge saw tools:",
    panelBridgeCalls.some((c) => c.startsWith("tools:")),
  );
  console.log("invoke LEAKED to bridge (must be false):", invokeReached);
  console.log("approval backend consulted:", trace.filter((t) => t.startsWith("APPROVAL")).length);

  server.close();
  process.exit(invokeReached ? 1 : 0);
});
