/** Exercise the actual Node stdio worker shutdown used by Desktop and unattended hosts. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { confinedWorkerEnvironment } from "../scripts/runtime-cost-smoke-isolation.mjs";

describe("built stdio worker module lifetime", () => {
  for (const desktop of [true, false]) {
    test(`${desktop ? "Desktop coding+Pet" : "headless coding"} awaits async engine and host cleanup on parent EOF`, async () => {
      const root = mkdtempSync(join(tmpdir(), "stdio-module-lifetime-"));
      const home = join(root, "home");
      const settings = join(home, ".code-shell");
      mkdirSync(settings, { recursive: true, mode: 0o700 });
      const guardLog = join(root, "worker-guard.jsonl");
      let modelRequests = 0;
      const fixture = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          modelRequests += 1;
          return new Response("Metadata queries must not call a model", { status: 500 });
        },
      });
      const origin = `http://127.0.0.1:${fixture.port}`;
      const marker = join(root, "released.jsonl");
      writeFileSync(
        join(settings, "settings.json"),
        JSON.stringify({
          credentials: [
            {
              id: "synthetic",
              catalogId: "deepseek",
              apiKey: "synthetic",
              baseUrl: `${origin}/v1`,
            },
          ],
          modelConnections: [
            {
              id: "synthetic",
              catalogId: "deepseek",
              tag: "text",
              model: "deepseek-v4-flash",
              credentialId: "synthetic",
            },
          ],
          defaults: { text: "synthetic" },
        }),
      );
      const probe = join(root, "probe.mjs");
      writeFileSync(
        probe,
        `import { appendFile } from "node:fs/promises";
        const release = async (kind) => { await new Promise((resolve) => setTimeout(resolve, 5)); await appendFile(${JSON.stringify(marker)}, kind + "\\n"); };
        export function createProbe() { return { id: "lifetime-probe", engine: { privateService: { scope: "engine", create: () => ({}), dispose: () => release("service") } }, activateEngine(ctx) { ctx.own(() => release("engine")); }, activateHost(ctx) { ctx.own(() => release("host")); } }; }
      `,
      );
      const modules = [
        `${new URL("../packages/coding/dist/index.js", import.meta.url).href}#createCodingModule`,
        ...(desktop
          ? [`${new URL("../packages/pet/dist/index.js", import.meta.url).href}#createPetModule`]
          : []),
        `${pathToFileURL(probe).href}#createProbe`,
      ].join(",");
      const worker = Bun.spawn({
        cmd: [
          Bun.which("node")!,
          fileURLToPath(
            new URL("../packages/core/dist/cli/agent-server-stdio.js", import.meta.url),
          ),
        ],
        cwd: root,
        env: {
          ...confinedWorkerEnvironment(
            process.env,
            home,
            origin,
            new URL("../scripts/runtime-cost-smoke-isolation.mjs", import.meta.url).href,
          ),
          CODE_SHELL_HOME: settings,
          CODE_SHELL_TEST_HOME: home,
          CODESHELL_COST_SMOKE_GUARD_LOG: guardLog,
          CODE_SHELL_DATA_ROOT: join(root, "data"),
          AGENT_CWD: root,
          CODE_SHELL_CAPABILITY_MODULES: modules,
          CODE_SHELL_CREDENTIAL_ACCESS: "local",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const errors = new Response(worker.stderr).text();
      const reader = worker.stdout.getReader();
      try {
        worker.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "agent/query",
            params: { type: "tools" },
          }) + "\n",
        );
        let pending = "";
        let reply: any;
        while (!reply) {
          const next = await reader.read();
          if (next.done) throw new Error(`worker exited before metadata query: ${await errors}`);
          pending += new TextDecoder().decode(next.value);
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) {
            const message = JSON.parse(line);
            if (message.id === 1) reply = message;
          }
        }
        expect(reply.error).toBeUndefined();
        expect(reply.result.data.some((tool: { name: string }) => tool.name === "Read")).toBe(true);
        const receipts = readFileSync(guardLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(receipts).toContainEqual({
          pid: worker.pid,
          ppid: process.pid,
          origin,
          homeId: createHash("sha256").update(home).digest("hex"),
        });
        // EOF happens only after the metadata Engine and Host have activated.
        worker.stdin.end();
        expect(await worker.exited).toBe(0);
        expect(await errors).toBe("");
        const released = readFileSync(marker, "utf8").trim().split("\n");
        // Bootstrap cancels the unused seed before async activators start; only
        // the detached metadata Engine activates. Both private services release.
        expect(released.filter((kind) => kind === "engine")).toHaveLength(1);
        expect(released.filter((kind) => kind === "service")).toHaveLength(2);
        expect(released.filter((kind) => kind === "host")).toHaveLength(1);
        expect(released.at(-1)).toBe("host");
        expect(released.lastIndexOf("engine")).toBeLessThan(released.indexOf("host"));
        expect(released.lastIndexOf("service")).toBeLessThan(released.indexOf("host"));
        expect(modelRequests).toBe(0);
      } finally {
        worker.kill();
        await worker.exited;
        reader.releaseLock();
        fixture.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
});
