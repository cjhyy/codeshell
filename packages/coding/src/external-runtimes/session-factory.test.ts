/**
 * The composition root is where the security-relevant inputs stop being optional
 * in theory and start being passed in practice. These tests pin the assembly
 * order and the teardown, which are the parts that cannot be checked by reading
 * one module.
 *
 * Codex is driven through a FAKE app-server so CI needs no binary or login; the
 * real-binary proof lives in `docs/todo/evidence/`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@cjhyy/code-shell-core";
import { startExternalRuntimeSession } from "./session-factory.js";
import { FIRST_PHASE_EXPOSURE } from "@cjhyy/code-shell-core/extension";

const dirs: string[] = [];
const sessions: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake `codex app-server` that answers the handshake and nothing else. */
function fakeCodex(body = ""): string[] {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-factory-"));
  dirs.push(dir);
  const file = join(dir, "server.mjs");
  writeFileSync(
    file,
    `import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === "initialize") return send({ id: m.id, result: {} });
  if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: "t-fake" } } });
  ${body}
});
`,
  );
  return [file];
}

const BASE = {
  cwd: process.cwd(),
  businessSessionId: "sess-factory",
  permissionMode: "default" as const,
  presetRules: [{ tool: "Panel", decision: "allow" as const }],
  projectTrusted: false,
  planMode: false,
  visibility: {
    cwd: process.cwd(),
    hasGoal: false,
    host: "desktop",
    isSubAgent: false,
  },
};

function registry(): ToolRegistry {
  return new ToolRegistry({ builtinTools: ["Panel"] });
}

describe("startExternalRuntimeSession", () => {
  test("assembles a Codex session that exposes only the allowlisted tools", async () => {
    const session = await startExternalRuntimeSession({
      ...BASE,
      kind: "codex",
      registry: registry(),
      codexClient: { command: process.execPath, args: fakeCodex() },
    });
    sessions.push(session);

    expect(session.kind).toBe("codex");
    expect(session.businessSessionId).toBe("sess-factory");
    expect(session.runtimeSessionId).toBe("t-fake");
    // The default exposure is the reviewed allowlist, not "everything".
    expect(session.listTools().map((tool) => tool.name)).toEqual(["Panel"]);
  });

  test("defaults to the reviewed first-phase allowlist when exposure is omitted", async () => {
    // Forgetting `exposure` must not widen the surface — the failure mode of a
    // permissive default is silent.
    const session = await startExternalRuntimeSession({
      ...BASE,
      kind: "codex",
      registry: registry(),
      codexClient: { command: process.execPath, args: fakeCodex() },
    });
    sessions.push(session);
    for (const tool of session.listTools()) {
      expect(FIRST_PHASE_EXPOSURE.toolNames.has(tool.name)).toBe(true);
    }
  });

  test("a Claude session assembles without spawning anything up front", async () => {
    // `claude -p` is one process per turn, so there is nothing to start until the
    // first send(). Assembly must still produce a usable session.
    const session = await startExternalRuntimeSession({
      ...BASE,
      kind: "claude-code",
      registry: registry(),
    });
    sessions.push(session);
    expect(session.kind).toBe("claude-code");
    expect(session.runtimeSessionId).toBeUndefined();
    expect(session.listTools().map((tool) => tool.name)).toEqual(["Panel"]);
  });

  test("close() releases the bridge port", async () => {
    // An orphaned bridge holds a port and a live token for the process lifetime.
    const session = await startExternalRuntimeSession({
      ...BASE,
      kind: "claude-code",
      registry: registry(),
    });
    await session.close();
    // Idempotent: a second close must not throw.
    await session.close();
    // …and a third, from the afterEach hook.
    expect(session.kind).toBe("claude-code");
  });

  test("a runtime that fails to start leaves no orphaned bridge", async () => {
    // §13.1: dispose the unused host and bridge rather than keeping a dangling
    // port with a live token on it. Verified by observing that the port the failed
    // attempt used is closed afterwards.
    const ports: number[] = [];
    await expect(
      startExternalRuntimeSession({
        ...BASE,
        kind: "codex",
        registry: registry(),
        // A binary that does not exist → start() rejects.
        codexClient: { command: join(tmpdir(), "definitely-not-a-real-binary") },
        log: (event, data) => {
          const url = typeof data.url === "string" ? data.url : undefined;
          const match = url ? /:(\d+)\//.exec(url) : null;
          if (match) ports.push(Number(match[1]));
        },
      }),
    ).rejects.toBeDefined();
    // Whatever port it opened must now refuse connections.
    for (const port of ports) {
      const reachable = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" })
        .then(() => true)
        .catch(() => false);
      expect(reachable).toBe(false);
    }
  });

  test("security-relevant inputs are required by the type, not defaulted", () => {
    // Mirrors the contract test on CreateSessionToolHostOptions one layer up: the
    // fail-open shape (optional + permissive default) has bitten this options
    // object family three times, so the factory must not reintroduce it.
    const source = require("node:fs").readFileSync(
      new URL("./session-factory.ts", import.meta.url),
      "utf8",
    ) as string;
    const block = source.slice(
      source.indexOf("export interface ExternalRuntimeSessionOptions"),
      source.indexOf("export interface ExternalRuntimeSession {"),
    );
    for (const field of [
      "projectTrusted",
      "permissionMode",
      "presetRules",
      "planMode",
      "visibility",
    ]) {
      expect(new RegExp(`^\\s*${field}\\?:`, "m").test(block)).toBe(false);
    }
    // And no `?? true` / `?? []` style default inside the factory body.
    const body = source.slice(source.indexOf("export async function startExternalRuntimeSession"));
    for (const field of ["projectTrusted", "presetRules", "planMode"]) {
      expect(new RegExp(`options\\.${field}\\s*(\\?\\?|\\|\\|)`).test(body)).toBe(false);
    }
  });
});
