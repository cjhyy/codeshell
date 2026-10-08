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
  if (request.url?.startsWith("/redirect/"))
    response.writeHead(Number(request.url.split("/").at(-1)), { location: "/destination" }).end();
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
  const expected = [];
  for (const method of ["PUT", "DELETE", "POST"]) {
    const paths =
      method === "POST"
        ? [301, 302, 303, 307, 308].map((status) => `/redirect/${status}`)
        : ["/redirect/307", "/lost"];
    for (const path of paths) {
      const follows = method !== "POST" ? path !== "/lost" : /30[123]$/.test(path);
      expected.push({ method, path });
      if (follows)
        expected.push({ method: method === "POST" ? "GET" : method, path: "/destination" });
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
          ...(method === "POST" ? ["--input", "-"] : ["-H", "Content-Length: 0"]),
        ],
        { env, stdio: [method === "POST" ? "pipe" : "ignore", "pipe", "pipe"] },
      );
      // Match the production issue adapter's non-replayable stdin body.
      if (method === "POST")
        child.stdin.end(JSON.stringify({ title: "Synthetic localhost audit" }));
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
        assert.equal(result.code, follows ? 0 : 1);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  assert.deepEqual(calls, expected);
  console.log(
    "Installed gh audit confirmed: PUT/DELETE follow 307 with a second mutation; stdin POST follows 301/302/303 with GET and exits successfully, but rejects 307/308 after one POST. Fresh PUT/DELETE EOF commands sent once. All CLI write capabilities remain disabled.",
  );
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  rmSync(directory, { recursive: true, force: true });
}
