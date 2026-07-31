/**
 * Phase 0-B decisive probe: stand up the EXACT thing §11.2 of the design
 * describes — a loopback-only Streamable HTTP MCP server with a bearer token —
 * point Codex at it, and record what identity metadata arrives on a tool call.
 *
 * The question the design could not answer: is there trustworthy thread identity
 * on an MCP request, so one shared bridge can serve concurrent Codex threads
 * without cross-talk? We log the FULL request (headers + JSON-RPC body incl.
 * `_meta`) for every call so the answer is evidence, not inference.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const TOKEN = randomBytes(32).toString("hex");
const observed = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const auth = req.headers.authorization ?? "";
    const authorized = auth === `Bearer ${TOKEN}`;
    let msg = null;
    try {
      msg = JSON.parse(body);
    } catch {
      /* notifications / empty */
    }

    // Codex advertises `accept: text/event-stream, application/json`. Reply as
    // SSE when it will take it — a plain JSON body made it treat the tool call as
    // cancelled by the host.
    const send = (obj) => {
      const payload = JSON.stringify(obj);
      const wantsSse = String(req.headers.accept ?? "").includes("text/event-stream");
      if (wantsSse) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`event: message\ndata: ${payload}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    };

    if (!authorized) {
      observed.push({ stage: "unauthorized", auth: auth ? "wrong-token" : "absent" });
      res.writeHead(401).end();
      return;
    }
    if (!msg) {
      res.writeHead(202).end();
      return;
    }

    if (msg.method === "initialize") {
      observed.push({
        stage: "initialize",
        headers: pickHeaders(req.headers),
        meta: msg.params?._meta ?? null,
        clientInfo: msg.params?.clientInfo ?? null,
      });
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
      observed.push({ stage: "tools/list", headers: pickHeaders(req.headers), meta: msg.params?._meta ?? null });
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "panel_list",
              description:
                "List panels available in the CodeShell Desktop host. Call this immediately when asked about panels.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
      });
    }
    if (msg.method === "tools/call") {
      // THE measurement: everything the host could possibly use for routing.
      observed.push({
        stage: "tools/call",
        tool: msg.params?.name,
        headers: pickHeaders(req.headers),
        meta: msg.params?._meta ?? null,
        fullParams: msg.params,
      });
      console.log("\n>>> tools/call RECEIVED");
      console.log("    headers:", JSON.stringify(pickHeaders(req.headers), null, 2));
      console.log("    params._meta:", JSON.stringify(msg.params?._meta ?? null));
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "quickChat\tQuick chat\nde\tDesign Studio" }] },
      });
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  });
});

function pickHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (["host", "content-length", "content-type", "connection", "accept-encoding"].includes(k)) continue;
    out[k] = k === "authorization" ? "Bearer <redacted>" : v;
  }
  return out;
}

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  console.log("loopback MCP bridge on", url);

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `mcp_servers.codeshell_tools.url="${url}"`,
    "-c",
    `mcp_servers.codeshell_tools.bearer_token_env_var="CODESHELL_MCP_TOKEN"`,
    "Use the panel_list tool from codeshell_tools to list panels, then reply with the list. Do not ask permission.",
  ];
  console.log("running: codex", args.slice(0, 6).join(" "), "...");

  const child = spawn("codex", args, {
    env: { ...process.env, CODESHELL_MCP_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));

  const done = new Promise((r) => child.on("close", r));
  const timer = setTimeout(() => child.kill("SIGTERM"), 150_000);
  await done;
  clearTimeout(timer);

  console.log("\n--- codex output (tail) ---");
  console.log(out.slice(-1500));

  console.log("\n================ OBSERVED MCP TRAFFIC ================");
  for (const o of observed) console.log(JSON.stringify(o).slice(0, 1400));
  const call = observed.find((o) => o.stage === "tools/call");
  console.log("\n=== VERDICT ===");
  console.log("tool was called:", Boolean(call));
  if (call) {
    console.log("_meta present:", call.meta !== null && call.meta !== undefined);
    console.log("_meta contents:", JSON.stringify(call.meta));
    const hdrKeys = Object.keys(call.headers);
    console.log("header keys:", hdrKeys.join(", "));
    const idish = hdrKeys.filter((k) => /thread|session|conversation|turn|trace/i.test(k));
    console.log("identity-ish headers:", idish.length ? idish.join(", ") : "(none)");
  }
  server.close();
  process.exit(0);
});
