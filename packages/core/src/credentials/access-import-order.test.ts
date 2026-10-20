import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("source-first imports retain credential metadata and the complete builtin catalog", () => {
  // A fresh module cache is essential: a registry-first import masks this cycle.
  // The guarded parent supplies private HOME/state; importing must make no request.
  const source = new URL("../tool-system/builtin/sources.ts", import.meta.url).href;
  const access = new URL("./access.ts", import.meta.url).href;
  const contract = new URL("../links/figma-mcp-contract.ts", import.meta.url).href;
  const runtime = new URL("../links/figma-mcp.ts", import.meta.url).href;
  const registry = new URL("../tool-system/registry.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
        import assert from "node:assert/strict";
        globalThis.fetch = () => { throw new Error("Import fixture must not make a request"); };
        const sources = await import(${JSON.stringify(source)});
        const access = await import(${JSON.stringify(access)});
        const contract = await import(${JSON.stringify(contract)});
        const runtime = await import(${JSON.stringify(runtime)});
        const { ToolRegistry } = await import(${JSON.stringify(registry)});
        const tools = new ToolRegistry({ builtinTools: ["ListSources", "ReadSource", "LinkAction"] });
        assert.equal(typeof sources.listSourcesTool, "function");
        assert.equal(typeof access.localCredentialAccess.resolveMeta, "function");
        for (const name of ["ListSources", "ReadSource", "LinkAction"]) assert.ok(tools.getTool(name));
        assert.equal(runtime.isFigmaMcpCredential, contract.isFigmaMcpCredential);
        assert.equal(runtime.McpLinkActionError, contract.McpLinkActionError);
        console.log("Source-first credential imports passed");
      `,
    ],
    { encoding: "utf8", timeout: 15_000, env: process.env },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("Source-first credential imports passed");
});
