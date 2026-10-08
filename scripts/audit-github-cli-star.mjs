import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";

// Optional diagnostic against an installed, real gh binary. No Core import,
// operator config/token, GitHub request, or remote redirect is used. Native gh
// does not run under the Node fetch guard; the server controls every destination.
const directory = mkdtempSync(join(tmpdir(), "codeshell-real-gh-star-"));
const calls = [];
const server = createServer((request, response) => {
  calls.push({ method: request.method, path: request.url });
  request.resume();
  if (request.url === "/redirect") response.writeHead(307, { location: "/destination" }).end();
  else if (request.url === "/lost") request.socket.destroy();
  else response.writeHead(204).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...createBunTestEnvironment(process.env, directory),
    GH_TOKEN: "synthetic-localhost-only",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
  };
  for (const method of ["PUT", "DELETE"]) {
    for (const path of ["/redirect", "/lost"]) {
      const child = spawn(
        process.argv[2] ?? "gh",
        [
          "api",
          `${origin}${path}`,
          "--hostname",
          "github.com",
          "--method",
          method,
          "--include",
          "-H",
          "Content-Length: 0",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      // Drain diagnostics, but never print credentials/headers returned by a CLI.
      child.stdout.resume();
      child.stderr.resume();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const result = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        assert.equal(result.signal, null);
        assert.equal(result.code, path === "/redirect" ? 0 : 1);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  assert.deepEqual(calls, [
    { method: "PUT", path: "/redirect" },
    { method: "PUT", path: "/destination" },
    { method: "PUT", path: "/lost" },
    { method: "DELETE", path: "/redirect" },
    { method: "DELETE", path: "/destination" },
    { method: "DELETE", path: "/lost" },
  ]);
  console.log(
    "Installed gh audit confirmed: PUT/DELETE each followed a 307 with a second mutation send; fresh lost-response commands sent once. CLI Star writes remain disabled.",
  );
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  rmSync(directory, { recursive: true, force: true });
}
