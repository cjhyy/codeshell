import http from "node:http";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [origin, destination, repo] = process.argv.slice(2);
const { installLocalNetworkGuard } = await import(
  pathToFileURL(join(repo, "scripts/runtime-cost-smoke-isolation.mjs")).href
);
installLocalNetworkGuard(origin);
// Quiet output is intentional: the downloaded file, rather than an inherited
// stdout pipe, owns progress. A downloader can survive its worker's pipe close.
await new Promise((resolve, reject) => {
  const request = http.get(`${origin}/slow`, (response) => {
    pipeline(response, createWriteStream(destination)).then(resolve, reject);
  });
  request.on("error", reject);
});
