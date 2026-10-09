import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
assert(
  globalThis[Symbol.for("codeshell.external-output.fixture-guard")],
  "pre-Core guard required",
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const server = createServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise((done) => server.close(done));
if (process.argv[2] === "cold") {
  const { cold } = await import(pathToFileURL(process.env.CODESHELL_OUTPUT_ADAPTERS));
  console.log(JSON.stringify(await cold(process.env.CODESHELL_OUTPUT_ROOT, port, process.argv[3])));
} else {
  console.log(
    JSON.stringify({
      preCore: true,
      pid: process.pid,
      ppid: process.ppid,
      homeHash: hash(process.env.HOME),
      fixtureHash: hash(readFileSync(process.env.CODESHELL_OUTPUT_ADAPTERS)),
    }),
  );
  const { run } = await import(pathToFileURL(process.env.CODESHELL_OUTPUT_ADAPTERS));
  await run(process.env.CODESHELL_OUTPUT_ROOT, port);
}
