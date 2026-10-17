import { afterAll, beforeAll, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  resolveSafe,
  serveMobile,
} from "../../../packages/server/src/mobile-remote/mobile-static.ts";

// A response sink for the exact operations used by serveMobile: writeHead,
// end, and Writable piping. No HTTP server, socket, or proxy is started.
async function capture(url: string) {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
  const sink = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  }) as Writable & {
    writeHead: (code: number, fields: Record<string, string>) => void;
  };
  sink.writeHead = (code, fields) => {
    status = code;
    headers = fields;
  };
  const finished = once(sink, "finish");
  const request = {
    method: "GET",
    url,
    headers: { accept: "image/svg+xml" },
  } as IncomingMessage;
  serveMobile(request, sink as unknown as ServerResponse, { rootDir: root });
  await finished;
  return { status, headers, body: Buffer.concat(chunks).toString("utf8") };
}

let root: string;
const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "codeshell-audit135-assets-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  writeFileSync(join(root, "assets", "plain.svg"), svg);
  writeFileSync(join(root, "assets", "icon one.svg"), svg);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("control: an existing plain asset streams successfully", async () => {
  const response = await capture("/mobile/assets/plain.svg");
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toBe("image/svg+xml");
  expect(response.body).toBe(svg);
});

test("observed defect: an existing space-named asset is 404 at its encoded URL", async () => {
  expect(resolveSafe(root, "assets/icon one.svg")).toBe(join(root, "assets", "icon one.svg"));
  const response = await capture(`/mobile/assets/${encodeURIComponent("icon one.svg")}`);
  expect(response.status).toBe(404);
  expect(response.body).toBe("not found");
});

test("control: a genuinely missing asset is 404", async () => {
  const response = await capture("/mobile/assets/missing.svg");
  expect(response.status).toBe(404);
  expect(response.body).toBe("not found");
});
