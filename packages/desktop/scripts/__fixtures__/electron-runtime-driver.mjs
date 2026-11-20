#!/usr/bin/env node
// Local MCP driver stand-in. The smoke exercises initialize, not native macOS access.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
assert.deepEqual(process.argv.slice(2, 5), ["mcp", "--embedded", "--socket"]);
assert.equal(process.env.CUA_DRIVER_EMBEDDED, "1");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  assert.equal(method, "initialize");
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: {},
        serverInfo: { name: "fixture-driver", version: "1" },
      },
    }) + "\n",
  );
});
