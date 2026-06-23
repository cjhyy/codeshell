import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { Engine } from "../../engine/engine.js";
import { agentTool, agentSendInputTool } from "./agent.js";
import { asyncAgentRegistry } from "./agent-registry.js";
import type { SubAgentSpawner, ToolContext } from "../context.js";

/**
 * Real-LLM end-to-end proof that send_input continuation actually carries the
 * sub-agent's memory across calls — the one thing the fake-spawner suite can't
 * show. Turn 1 spawns a child told to remember a number; Turn 2 (AgentSendInput)
 * resumes that SAME session and asks it to recall. If transcript replay works,
 * the child answers with the original number.
 *
 * Gated behind RUN_LLM_E2E=1 (hits a real provider, costs tokens, needs a key).
 * Default: skipped, so CI / keyless runs stay green. Run with:
 *   RUN_LLM_E2E=1 bun test src/tool-system/builtin/agent.send-input.llm.test.ts
 *
 * Uses the deepseek connection from the user's ~/.code-shell/settings.json
 * (text model, cheap, fast). The spawner mirrors engine.ts's spawn closure:
 * a fresh child Engine per call, child.run(prompt, { sessionId }) — resume when
 * resumeSessionId is set, cold-start under agent_id otherwise.
 */

const RUN = process.env.RUN_LLM_E2E === "1";

/**
 * Pick a usable text connection from the user's settings. Tries connections in
 * order and returns the first whose credential has an apiKey. provider is the
 * catalog's adapterKind. (Set CS_LLM_CONN to force a specific connection id.)
 */
function loadTextConn(): { apiKey: string; baseUrl: string; model: string; provider: string } | null {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".code-shell", "settings.json"), "utf-8"));
    const order = process.env.CS_LLM_CONN
      ? [process.env.CS_LLM_CONN]
      : ["openrouter", "deepseek", "openai", "zhipu-glm-5-2-1m"];
    // catalogId → adapterKind (OpenAI-compatible default for most).
    const kindOf: Record<string, string> = {
      openrouter: "openrouter",
      deepseek: "deepseek",
      openai: "openai",
      "zhipu-glm-5-2-1m": "openai",
    };
    for (const id of order) {
      const conn = (s.modelConnections ?? []).find((c: { id: string }) => c.id === id);
      if (!conn) continue;
      const cred = (s.credentials ?? []).find((c: { id: string }) => c.id === conn.credentialId);
      if (!cred?.apiKey) continue;
      return {
        apiKey: cred.apiKey,
        baseUrl: cred.baseUrl ?? "",
        model: conn.model,
        provider: kindOf[conn.catalogId] ?? "openai",
      };
    }
    return null;
  } catch {
    return null;
  }
}

const ds = RUN ? loadTextConn() : null;
const describeMaybe = RUN && ds ? describe : describe.skip;

describeMaybe("send_input continuation — REAL LLM memory recall", () => {
  let storageDir: string;
  let spawner: SubAgentSpawner;

  beforeAll(() => {
    storageDir = mkdtempSync(join(tmpdir(), "cs-sendinput-llm-"));
    process.env.CODE_SHELL_AGENT_BG_MS = "0"; // keep sync
    asyncAgentRegistry.reset();
    // Minimal real spawner mirroring engine.ts's spawn closure core.
    spawner = {
      spawn: async (req) => {
        const child = new Engine({
          llm: { provider: ds!.provider, model: ds!.model, apiKey: ds!.apiKey, baseUrl: ds!.baseUrl },
          cwd: storageDir,
          sessionStorageDir: storageDir,
          maxTurns: req.maxTurns,
          headless: true,
          isSubAgent: true,
        } as ConstructorParameters<typeof Engine>[0]);
        const childSessionId = req.resumeSessionId ?? req.agentId;
        const result = await child.run(req.prompt, { signal: req.signal, sessionId: childSessionId });
        return { text: result.text, sessionId: result.sessionId };
      },
      // Child sessions persist under storageDir/<sid>/state.json (agent_id===sid).
      sessionExists: (sid) => existsSync(join(storageDir, sid, "state.json")),
      parentStream: () => {},
      describe: () => ({ cwd: storageDir, permissionMode: "bypassPermissions" }),
    };
  });

  afterAll(() => {
    rmSync(storageDir, { recursive: true, force: true });
    delete process.env.CODE_SHELL_AGENT_BG_MS;
    asyncAgentRegistry.reset();
  });

  it("recalls a number told in the first turn via AgentSendInput (≥90s)", async () => {
    const ctx = { subAgentSpawner: spawner, sessionId: "s-parent" } as unknown as ToolContext;

    // Turn 1: spawn a child, tell it to remember a distinctive number.
    const spawnRes = await agentTool(
      {
        description: "memory test",
        prompt:
          "Remember this number for later: 4291. Just acknowledge briefly that you'll remember it. Do not use any tools.",
      },
      ctx,
    );
    // Extract the agent_id the Agent tool reported (internal trailer) — but with
    // BG_MS=0 sync path returns the text directly; agent_id===childSid is the
    // session it wrote. The registry holds the mapping.
    const running = asyncAgentRegistry.getSnapshot();
    const agentId = running[running.length - 1]?.agentId;
    expect(agentId).toBeTruthy();
    expect(typeof spawnRes).toBe("string");

    // Turn 2: continue the SAME sub-agent. If replay works it recalls 4291.
    const recall = await agentSendInputTool(
      { agent_id: agentId, prompt: "What was the number I asked you to remember? Reply with just the number." },
      ctx,
    );
    expect(recall).toContain("4291");
  }, 120_000);
});
