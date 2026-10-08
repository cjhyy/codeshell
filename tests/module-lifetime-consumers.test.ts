/** Host composition checks through built package entries; run after the package build gate. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileComposition,
  createServer,
  createClient,
  createInProcessTransport,
  type AgentModule,
} from "../packages/core/dist/index.js";
import { createCodingModule } from "../packages/coding/dist/index.js";
import { createPetModule } from "../packages/pet/dist/index.js";

describe("built host composition lifetime", () => {
  for (const host of ["TUI", "Desktop worker", "headless"] as const) {
    test(`${host} activates the real capability factories and awaits owned resource cleanup`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "host-module-lifetime-"));
      const released: string[] = [];
      const modules: AgentModule[] = [
        createCodingModule(),
        ...(host === "Desktop worker" ? [createPetModule()] : []),
        {
          id: "host-proof",
          activateHost(ctx) {
            ctx.own(async () => {
              await Promise.resolve();
              released.push("host");
            });
          },
          activateEngine(ctx) {
            ctx.own(async () => {
              await Promise.resolve();
              released.push("engine");
            });
          },
        },
      ];
      const composition = compileComposition({ modules });
      const [serverTransport, clientTransport] = createInProcessTransport();
      const handle = createServer({
        transport: serverTransport,
        cwd,
        llm: { provider: "openai", model: "synthetic", apiKey: "synthetic" },
        engineOverrides: {
          composition,
          settingsScope: "isolated",
          sessionStorageDir: join(cwd, "sessions"),
          isSubAgent: true,
          headless: host === "headless",
        },
      });
      const client = createClient({ transport: clientTransport });
      try {
        await handle.engine.ready();
        expect(handle.engine.getComposition()).toBe(composition);
        expect(handle.engine.getToolRegistry().hasTool("Read")).toBe(true);
        const service = handle.engine.buildToolContext().capabilityServices?.coding;
        expect(service).toBeDefined();
        expect(handle.engine.buildToolContext().capabilityServices?.coding).toBe(service);
        if (host === "Desktop worker") {
          const projection = await (client as any).request("agent/getPetProjectionSnapshot");
          expect(projection).toBeDefined();
        }
        const closing = handle.close();
        expect(handle.close()).toBe(closing);
        await closing;
        expect(released).toEqual(["engine", "host"]);
        expect(handle.engine.getToolRegistry().listTools()).toEqual([]);
        expect(() => handle.engine.buildToolContext()).toThrow("disposed");
      } finally {
        await handle.close();
        client.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
