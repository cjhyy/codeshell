import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PanelResourceService } from "./service.js";
import type { ResourceScope } from "./types.js";

/** Browser byte transport; scope and reader are resolved by the authenticated Host. */
export async function servePanelResource(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    service: PanelResourceService;
    scope: ResourceScope;
    id: string;
    download: boolean;
    isAuthorized(): Promise<boolean>;
  },
) {
  let source: Readable | null = null;
  const authorize = async () => {
    if (request.aborted || response.destroyed || !(await options.isAuthorized()))
      throw new Error("Resource authorization expired");
  };
  try {
    await authorize();
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const asset = await options.service.get(options.scope, options.id);
    const result = await options.service.openRead(options.scope, options.id, {
      range: request.headers.range,
      method: asset.bytes === 0 ? "HEAD" : request.method,
    });
    source = result.body;
    await authorize();
    const headers: Record<string, string> = { ...result.headers, "Referrer-Policy": "no-referrer" };
    if (options.download)
      headers["Content-Disposition"] =
        `attachment; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/['()*!]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    response.writeHead(result.status, headers);
    if (!source) {
      response.end();
      return;
    }
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void authorize()
        .catch(() => {
          source?.destroy();
          response.destroy();
        })
        .finally(() => {
          checking = false;
        });
    }, 250);
    timer.unref();
    try {
      await pipeline(
        Readable.from(
          (async function* () {
            for await (const chunk of source!) {
              await authorize();
              yield chunk;
            }
          })(),
          { objectMode: false },
        ),
        response,
      );
    } finally {
      clearInterval(timer);
    }
  } catch {
    if (response.headersSent || response.destroyed) response.destroy();
    else
      response
        .writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .end(
          request.method === "HEAD" ? undefined : "文件不可用或访问授权已失效，请重新打开面板。",
        );
  } finally {
    source?.destroy();
  }
}
